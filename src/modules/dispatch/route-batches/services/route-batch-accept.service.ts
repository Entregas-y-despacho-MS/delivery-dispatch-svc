import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { InsufficientPermissionsException } from '../../../../app/auth/exceptions/index.js';
import {
  DispatchStatusEnum,
  RouteBatchStatusEnum,
} from '../../../../shared/enums/index.js';
import { assertDriverCanAcceptBatch } from '../domain/batch-acceptance.js';
import {
  AcceptRouteBatchDto,
  CotejoFailureDto,
} from '../dto/accept-route-batch.dto.js';
import { AcceptRouteBatchResponseDto } from '../dto/accept-route-batch-response.dto.js';
import {
  CotejoFailureInvalidException,
  RouteBatchAcceptConflictException,
} from '../exceptions/route-batch-accept-conflict.exception.js';
import { RouteBatchNotFoundException } from '../exceptions/route-batch-not-found.exception.js';
import { COTEJO_PHOTO_EVENT_TYPE } from './route-batch-cotejo-photo.service.js';

export const BATCH_ACCEPTED_EVENT_TYPE = 'batch_accepted';
export const COTEJO_FAILED_EVENT_TYPE = 'cotejo_failed';

interface AcceptedMetadata {
  eventId: string;
  acceptedAt: string;
  failedDispatchIds: number[];
}

// "Aceptar lote" (ST-210.1, RF-U24): the driver accepts a confirmed batch after checking the physical load.
// Every package that failed the check becomes a `cotejo_failed` dispatch event (the stop does not leave); the
// batch gets `accepted_at`, which "Iniciar Ruta del Día" (ST-51.5) then requires. It takes the batch lock first,
// the same one the route start takes, so the two cannot interleave.
@Injectable()
export class RouteBatchAcceptService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async accept(
    routeBatchId: number,
    dto: AcceptRouteBatchDto,
    driverId: number,
  ): Promise<AcceptRouteBatchResponseDto> {
    return await this.dataSource.transaction(async (manager) => {
      const [batch]: {
        status: string;
        driver_id: number | null;
        accepted_at: Date | null;
      }[] = await manager.query(
        `SELECT status, driver_id, accepted_at FROM route_batches WHERE route_batch_id = $1 FOR UPDATE`,
        [routeBatchId],
      );
      if (!batch) throw new RouteBatchNotFoundException();
      if (batch.driver_id !== driverId)
        throw new InsufficientPermissionsException();

      // Serialize use of the same client event id even if two requests target different batches.
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',
        [`batch-accept:${dto.eventId}`],
      );
      const [prior]: { route_batch_id: number; metadata: AcceptedMetadata }[] =
        await manager.query(
          `SELECT route_batch_id, metadata FROM route_batch_events
            WHERE event_type = $1 AND metadata->>'eventId' = $2 LIMIT 1`,
          [BATCH_ACCEPTED_EVENT_TYPE, dto.eventId],
        );
      if (prior) {
        if (prior.route_batch_id !== routeBatchId)
          throw new RouteBatchAcceptConflictException(
            'ROUTE_ACCEPT_EVENT_ID_ALREADY_USED',
            'This eventId was already used to accept another route batch.',
          );
        return {
          routeBatchId,
          acceptedAt: prior.metadata.acceptedAt,
          failedDispatchIds: prior.metadata.failedDispatchIds,
        };
      }

      assertDriverCanAcceptBatch(batch.status);
      if (batch.accepted_at)
        throw new RouteBatchAcceptConflictException(
          'ROUTE_BATCH_ALREADY_ACCEPTED',
          'The route batch was already accepted.',
        );

      const failures = dto.failures ?? [];
      const photoUrls = await this.validateFailures(
        manager,
        routeBatchId,
        failures,
      );

      const acceptedAt = new Date();
      // TypeORM answers UPDATE ... RETURNING with [rows, affectedCount].
      const [updatedRows]: [unknown[], number] = await manager.query(
        `UPDATE route_batches SET accepted_at = $2, updated_at = $2
          WHERE route_batch_id = $1 AND status = $3 AND accepted_at IS NULL RETURNING route_batch_id`,
        [routeBatchId, acceptedAt, RouteBatchStatusEnum.CONFIRMED],
      );
      if (!updatedRows.length)
        throw new RouteBatchAcceptConflictException(
          'ROUTE_BATCH_ALREADY_ACCEPTED',
          'The route batch changed before it could be accepted.',
        );

      for (const failure of failures) {
        await manager.query(
          `INSERT INTO dispatch_events (dispatch_id, event_type, actor_user_id, actor_type, reason, metadata)
           VALUES ($1, $2, $3, 'user', $4, $5::jsonb)`,
          [
            failure.dispatchId,
            COTEJO_FAILED_EVENT_TYPE,
            driverId,
            failure.reason,
            JSON.stringify({
              eventId: dto.eventId,
              routeBatchId,
              packageIds: failure.packageIds,
              reason: failure.reason,
              detail: failure.detail ?? null,
              photoId: failure.photoId,
              photo: photoUrls.get(failure.photoId),
            }),
          ],
        );
      }

      const failedDispatchIds = failures.map(({ dispatchId }) => dispatchId);
      const metadata: AcceptedMetadata = {
        eventId: dto.eventId,
        acceptedAt: acceptedAt.toISOString(),
        failedDispatchIds,
      };
      await manager.query(
        `INSERT INTO route_batch_events (route_batch_id, event_type, actor_user_id, actor_type, reason, metadata)
         VALUES ($1, $2, $3, 'user', 'Driver accepted the batch', $4::jsonb)`,
        [
          routeBatchId,
          BATCH_ACCEPTED_EVENT_TYPE,
          driverId,
          JSON.stringify({
            ...metadata,
            driverId,
            failures: failures.map(({ dispatchId, packageIds, reason }) => ({
              dispatchId,
              packageIds,
              reason,
            })),
          }),
        ],
      );
      return { routeBatchId, acceptedAt: metadata.acceptedAt, failedDispatchIds };
    });
  }

  /** Checks every failure against the batch and returns the stored URL of each photo, by photoId. */
  private async validateFailures(
    manager: EntityManager,
    routeBatchId: number,
    failures: CotejoFailureDto[],
  ): Promise<Map<string, string>> {
    const photoUrls = new Map<string, string>();
    if (failures.length === 0) return photoUrls;

    const dispatchIds = failures.map(({ dispatchId }) => dispatchId);
    if (new Set(dispatchIds).size !== dispatchIds.length)
      throw new CotejoFailureInvalidException(
        'COTEJO_FAILURE_DUPLICATED_DISPATCH',
        'Send one failure per dispatch; list every affected package in its packageIds.',
      );

    const inBatch: { dispatch_id: number; status: string }[] =
      await manager.query(
        `SELECT d.dispatch_id, s.name AS status
           FROM dispatches d
           JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
          WHERE d.route_batch_id = $1 AND d.dispatch_id = ANY($2::int[])`,
        [routeBatchId, dispatchIds],
      );
    const known = new Set(inBatch.map(({ dispatch_id }) => dispatch_id));
    const outside = dispatchIds.filter((id) => !known.has(id));
    if (outside.length)
      throw new CotejoFailureInvalidException(
        'COTEJO_FAILURE_DISPATCH_NOT_IN_BATCH',
        `Dispatches ${outside.join(', ')} do not belong to this route batch.`,
      );
    // Only a stop that is still waiting to leave can fail the check: a cancelled or rescheduled one has no load to check.
    const notAssigned = inBatch.filter(
      ({ status }) => status !== DispatchStatusEnum.ASSIGNED,
    );
    if (notAssigned.length)
      throw new CotejoFailureInvalidException(
        'COTEJO_FAILURE_DISPATCH_NOT_ASSIGNED',
        `Dispatches ${notAssigned.map(({ dispatch_id }) => dispatch_id).join(', ')} are not assigned, so they cannot fail the check.`,
      );

    const packages: { dispatch_id: number; external_package_id: string }[] =
      await manager.query(
        `SELECT dispatch_id, external_package_id FROM dispatch_packages WHERE dispatch_id = ANY($1::int[])`,
        [dispatchIds],
      );
    const owned = new Set(
      packages.map((p) => `${p.dispatch_id}:${p.external_package_id}`),
    );
    for (const failure of failures) {
      const foreign = failure.packageIds.filter(
        (id) => !owned.has(`${failure.dispatchId}:${id}`),
      );
      if (foreign.length)
        throw new CotejoFailureInvalidException(
          'COTEJO_FAILURE_PACKAGE_NOT_IN_DISPATCH',
          `Packages ${foreign.join(', ')} do not belong to dispatch ${failure.dispatchId}.`,
        );
    }

    const photoIds = [...new Set(failures.map(({ photoId }) => photoId))];
    const photos: { photo_id: string; photo_url: string }[] =
      await manager.query(
        `SELECT metadata->>'photoId' AS photo_id, metadata->>'photoUrl' AS photo_url
           FROM route_batch_events
          WHERE route_batch_id = $1 AND event_type = $2 AND metadata->>'photoId' = ANY($3::text[])`,
        [routeBatchId, COTEJO_PHOTO_EVENT_TYPE, photoIds],
      );
    for (const { photo_id, photo_url } of photos)
      photoUrls.set(photo_id, photo_url);
    const missing = photoIds.filter((id) => !photoUrls.has(id));
    if (missing.length)
      throw new CotejoFailureInvalidException(
        'COTEJO_PHOTO_NOT_FOUND',
        `Photos ${missing.join(', ')} were not uploaded for this route batch.`,
      );
    return photoUrls;
  }
}
