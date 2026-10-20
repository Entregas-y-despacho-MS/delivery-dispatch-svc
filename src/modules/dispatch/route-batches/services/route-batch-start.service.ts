import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { buildEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import { InsufficientPermissionsException } from '../../../../app/auth/exceptions/index.js';
import {
  DispatchStatusEnum,
  RouteBatchStatusEnum,
} from '../../../../shared/enums/index.js';
import { OutboxService } from '../../../messaging/outbound-messages/services/outbox.service.js';
import { RouteBatchNotFoundException } from '../exceptions/route-batch-not-found.exception.js';
import { RouteBatchStartConflictException } from '../exceptions/route-batch-start-conflict.exception.js';
import { StartRouteBatchDto } from '../dto/start-route-batch.dto.js';
import { StartRouteBatchResponseDto } from '../dto/start-route-batch-response.dto.js';
import {
  DISPATCH_STATUS_CHANGED_EVENT,
  type DispatchStatusChangedEvent,
} from '../../../../app/dispatch-status/dispatch-status-changed.event.js';

interface BatchRow {
  id: number;
  status: string;
  driver_id: number | null;
  accepted_at: Date | null;
}
interface DispatchRow {
  id: number;
  version: number;
  sequence_order: number | null;
  status: string;
  source_order_ref: string;
  tracking_code: string | null;
}
interface PackageRow {
  dispatch_id: number;
  external_package_id: string;
}
interface StartedMetadata {
  eventId: string;
  dispatchIds: number[];
  excludedDispatchIds?: number[];
  startedAt: string;
}
interface LatestCotejoEventRow {
  dispatch_id: number;
  event_type: 'cotejo_failed' | 'cotejo_resolved';
}
interface StartResult extends StartRouteBatchResponseDto {
  events: DispatchStatusChangedEvent[];
}

@Injectable()
export class RouteBatchStartService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
    private readonly events: EventEmitter2,
  ) {}

  async start(
    routeBatchId: number,
    dto: StartRouteBatchDto,
    driverId: number,
  ): Promise<StartRouteBatchResponseDto> {
    const runner = this.dataSource.createQueryRunner();
    let result: StartResult;
    await runner.connect();
    try {
      await runner.startTransaction();
      try {
        result = await this.commitStart(runner, routeBatchId, dto, driverId);
        await runner.commitTransaction();
      } catch (error) {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        throw error;
      }
    } finally {
      await runner.release();
    }

    for (const event of result.events)
      this.events.emit(DISPATCH_STATUS_CHANGED_EVENT, event);
    const { events: _events, ...response } = result;
    return response;
  }

  private async commitStart(
    runner: QueryRunner,
    routeBatchId: number,
    dto: StartRouteBatchDto,
    actorUserId: number,
  ): Promise<StartResult> {
    const manager = runner.manager;
    const [batch]: BatchRow[] = await manager.query(
      `SELECT route_batch_id AS id, status, driver_id, accepted_at FROM route_batches WHERE route_batch_id = $1 FOR UPDATE`,
      [routeBatchId],
    );
    if (!batch) throw new RouteBatchNotFoundException();
    if (batch.driver_id === null)
      throw new RouteBatchStartConflictException(
        'ROUTE_BATCH_DRIVER_REQUIRED',
        'Assign a driver before starting the route.',
      );
    if (batch.driver_id !== actorUserId)
      throw new InsufficientPermissionsException();

    // Serialize use of the same client event id even if two requests target different batches.
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [
      dto.eventId,
    ]);
    const [prior]: { route_batch_id: number; metadata: StartedMetadata }[] =
      await manager.query(
        `SELECT route_batch_id, metadata FROM route_batch_events
        WHERE event_type = 'route_started' AND metadata->>'eventId' = $1
        LIMIT 1`,
        [dto.eventId],
      );
    if (prior) {
      if (prior.route_batch_id !== routeBatchId) {
        throw new RouteBatchStartConflictException(
          'ROUTE_START_EVENT_ID_ALREADY_USED',
          'This eventId was already used to start another route batch.',
        );
      }
      return {
        routeBatchId,
        status: RouteBatchStatusEnum.IN_EXECUTION,
        dispatchIds: prior.metadata.dispatchIds,
        excludedDispatchIds: prior.metadata.excludedDispatchIds ?? [],
        startedAt: prior.metadata.startedAt,
        events: [],
      };
    }

    if (batch.status !== RouteBatchStatusEnum.CONFIRMED) {
      throw new RouteBatchStartConflictException(
        'ROUTE_BATCH_NOT_CONFIRMED',
        `Only a confirmed route batch can start (current status: ${batch.status}).`,
      );
    }

    // The driver must accept the batch and check the load first (ST-210.1, RF-U24).
    if (!batch.accepted_at) {
      throw new RouteBatchStartConflictException(
        'ROUTE_BATCH_NOT_ACCEPTED',
        'Accept the route batch and check the load before starting the route.',
      );
    }

    const dispatches: DispatchRow[] = await manager.query(
      `SELECT d.dispatch_id AS id, d.version, d.sequence_order, s.name AS status, d.source_order_ref, d.tracking_code
         FROM dispatches d
         JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
        WHERE d.route_batch_id = $1 ORDER BY d.sequence_order, d.dispatch_id FOR UPDATE OF d`,
      [routeBatchId],
    );
    if (dispatches.length === 0)
      throw new RouteBatchStartConflictException(
        'ROUTE_BATCH_HAS_NO_DISPATCHES',
        'The route batch has no dispatches to start.',
      );

    // ST-210.1 records cotejo outcomes as append-only dispatch events. A newer
    // resolution for the same dispatch and batch cancels its previous failure.
    // ST-210.1 must take the route-batch lock before appending these events so
    // route start and a concurrent cotejo update are serialized.
    const latestCotejoEvents: LatestCotejoEventRow[] = await manager.query(
      `SELECT DISTINCT ON (e.dispatch_id) e.dispatch_id, e.event_type
         FROM dispatch_events e
        WHERE e.dispatch_id = ANY($1::int[])
          AND e.event_type IN ('cotejo_failed', 'cotejo_resolved')
          AND e.metadata->>'routeBatchId' = $2::text
        ORDER BY e.dispatch_id, e.created_at DESC, e.dispatch_event_id DESC`,
      [dispatches.map(({ id }) => id), routeBatchId],
    );
    const excludedIds = new Set(
      latestCotejoEvents
        .filter(({ event_type }) => event_type === 'cotejo_failed')
        .map(({ dispatch_id }) => dispatch_id),
    );
    const excludedDispatchIds = dispatches
      .filter(({ id }) => excludedIds.has(id))
      .map(({ id }) => id);
    const departingDispatches = dispatches.filter(
      ({ id }) => !excludedIds.has(id),
    );
    if (departingDispatches.length === 0)
      throw new RouteBatchStartConflictException(
        'ROUTE_BATCH_ALL_DISPATCHES_EXCLUDED',
        'No dispatches can depart because every dispatch has an unresolved package-check failure.',
      );

    const notAssigned = departingDispatches.filter(
      ({ status }) => status !== DispatchStatusEnum.ASSIGNED,
    );
    if (notAssigned.length)
      throw new RouteBatchStartConflictException(
        'DISPATCH_NOT_ASSIGNED',
        `Dispatches ${notAssigned.map(({ id }) => id).join(', ')} are not assigned.`,
      );
    const missingTracking = departingDispatches.filter(
      ({ tracking_code }) => !tracking_code?.trim(),
    );
    if (missingTracking.length)
      throw new RouteBatchStartConflictException(
        'DISPATCH_TRACKING_CODE_REQUIRED',
        `Dispatches ${missingTracking.map(({ id }) => id).join(', ')} have no tracking code required by the outbound contract.`,
      );

    const packages: PackageRow[] = await manager.query(
      `SELECT dispatch_id, external_package_id FROM dispatch_packages
        WHERE dispatch_id = ANY($1::int[]) ORDER BY dispatch_id, external_package_id`,
      [departingDispatches.map(({ id }) => id)],
    );
    const packageIds = new Map<number, string[]>();
    for (const row of packages)
      packageIds.set(row.dispatch_id, [
        ...(packageIds.get(row.dispatch_id) ?? []),
        row.external_package_id,
      ]);
    const missingPackages = departingDispatches.filter(
      ({ id }) => !packageIds.get(id)?.length,
    );
    if (missingPackages.length)
      throw new RouteBatchStartConflictException(
        'DISPATCH_PACKAGES_REQUIRED',
        `Dispatches ${missingPackages.map(({ id }) => id).join(', ')} have no registered packages.`,
      );

    const startedAt = new Date();
    const updatedBatch: { updated_at: Date }[] = await manager.query(
      `UPDATE route_batches SET status = $2, updated_at = $3
        WHERE route_batch_id = $1 AND status = $4 RETURNING updated_at`,
      [
        routeBatchId,
        RouteBatchStatusEnum.IN_EXECUTION,
        startedAt,
        RouteBatchStatusEnum.CONFIRMED,
      ],
    );
    if (!updatedBatch.length)
      throw new RouteBatchStartConflictException(
        'ROUTE_BATCH_NOT_CONFIRMED',
        'The route batch changed before it could start.',
      );

    const dispatchEvents: DispatchStatusChangedEvent[] = [];
    for (const dispatch of departingDispatches) {
      const updated: { dispatch_id: number }[] = await manager.query(
        `UPDATE dispatches SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $2), updated_at = $3
          WHERE dispatch_id = $1 AND route_batch_id = $4
            AND dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $5)
          RETURNING dispatch_id`,
        [
          dispatch.id,
          DispatchStatusEnum.OUT_FOR_DELIVERY,
          startedAt,
          routeBatchId,
          DispatchStatusEnum.ASSIGNED,
        ],
      );
      if (!updated.length)
        throw new RouteBatchStartConflictException(
          'DISPATCH_NOT_ASSIGNED',
          `Dispatch ${dispatch.id} changed before route start.`,
        );
      const ids = packageIds.get(dispatch.id)!;
      const dispatchUpdatedAt = startedAt.toISOString();
      await manager.query(
        `INSERT INTO dispatch_events (dispatch_id, event_type, actor_user_id, actor_type, reason, metadata)
         VALUES ($1, 'status_changed', $2, 'user', 'Driver started route', $3::jsonb)`,
        [
          dispatch.id,
          actorUserId,
          JSON.stringify({
            eventId: dto.eventId,
            routeBatchId,
            previousStatus: DispatchStatusEnum.ASSIGNED,
            status: DispatchStatusEnum.OUT_FOR_DELIVERY,
            departedAt: startedAt.toISOString(),
            driverId: actorUserId,
            packageIds: ids,
          }),
        ],
      );
      const envelope = buildEnvelope({
        type: 'dispatch.shipment.departed',
        source: 'dispatch',
        occurredAt: startedAt,
        data: {
          salesOrderId: dispatch.source_order_ref,
          trackingCode: dispatch.tracking_code!,
          // `dispatches.version` (contador de planificación, DEFAULT 0, solo cambia al aprobar/
          // mover/fusionar/congelar) y `recordVersion` del contrato entre microservicios (créciente
          // desde 1, `envelope.schema.json`) son dos cosas distintas con el mismo nombre de columna
          // de origen. Sin el +1, cualquier despacho que nunca pasó por esas operaciones (el caso
          // común, no el raro) manda `recordVersion: 0` y el envelope lo rechaza, revirtiendo TODO
          // el inicio de ruta (bug real, encontrado probando ST-210.2 contra `dev` 2026-10-20).
          recordVersion: dispatch.version + 1,
          updatedAt: dispatchUpdatedAt,
          departedAt: startedAt.toISOString(),
          driverId: String(actorUserId),
          packageIds: ids,
        },
      });
      await this.outbox.enqueue(envelope, { manager });
      dispatchEvents.push({
        dispatchId: dispatch.id,
        previousStatus: DispatchStatusEnum.ASSIGNED,
        status: DispatchStatusEnum.OUT_FOR_DELIVERY,
        version: dispatch.version,
        updatedAt: dispatchUpdatedAt,
      });
    }

    const metadata: StartedMetadata = {
      eventId: dto.eventId,
      dispatchIds: departingDispatches.map(({ id }) => id),
      excludedDispatchIds,
      startedAt: startedAt.toISOString(),
    };
    await manager.query(
      `INSERT INTO route_batch_events (route_batch_id, event_type, actor_user_id, actor_type, reason, metadata)
       VALUES ($1, 'route_started', $2, 'user', 'Driver started route', $3::jsonb)`,
      [
        routeBatchId,
        actorUserId,
        JSON.stringify({
          ...metadata,
          driverId: actorUserId,
          previousStatus: RouteBatchStatusEnum.CONFIRMED,
          status: RouteBatchStatusEnum.IN_EXECUTION,
          dispatches: dispatches.map(({ id }) => ({
            dispatchId: id,
            packageIds: packageIds.get(id),
          })),
        }),
      ],
    );

    return {
      routeBatchId,
      status: RouteBatchStatusEnum.IN_EXECUTION,
      dispatchIds: metadata.dispatchIds,
      excludedDispatchIds: metadata.excludedDispatchIds ?? [],
      startedAt: metadata.startedAt,
      events: dispatchEvents,
    };
  }
}
