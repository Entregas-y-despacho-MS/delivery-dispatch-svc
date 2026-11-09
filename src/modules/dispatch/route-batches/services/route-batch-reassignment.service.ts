import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { DispatchNotFoundException } from '../../dispatches/exceptions/dispatch-not-found.exception.js';
import { RescheduleReasonInvalidException } from '../../../../app/dispatch-reschedule/exceptions/reschedule-reason-invalid.exception.js';
import { RouteBatchStatusEnum } from '../../../../shared/enums/route-batch-status.enum.js';
import { DispatchStatusEnum } from '../../../../shared/enums/dispatch-status.enum.js';
import { BatchExitService, type LockedBatch } from '../../../../app/dispatch-reschedule/services/batch-exit.service.js';
import { RouteCapacityService } from './route-capacity.service.js';
import { RouteBatchNotFoundException } from '../exceptions/route-batch-not-found.exception.js';
import { RouteBatchReassignConflictException } from '../exceptions/route-batch-reassign-conflict.exception.js';
import { ReassignRouteBatchDto } from '../dto/reassign-route-batch.dto.js';
import { ReassignRouteBatchResponseDto } from '../dto/reassign-route-batch-response.dto.js';
import { ROUTE_BATCH_REASSIGNED_EVENT, type RouteBatchReassignedEvent } from '../events/route-batch-reassigned.event.js';

interface BatchRow {
    id: number;
    status: string;
    version: number;
    driver_id: number | null;
    vehicle_id: number | null;
}

interface DispatchRow {
    dispatch_id: number;
    route_batch_id: number | null;
    status: string;
}

interface ZoneRow {
    name: string | null;
}

/**
 * ES-63 (ST-63.1): moves stops `out_for_delivery` from one `in_execution` route batch to another, for a
 * contingency on the road (RF-A16). Reuses `BatchExitService` for the origin side exactly as the
 * reschedule flow does — `batchExitPolicy('in_execution')` already does the right thing (no gap close,
 * no cancel-when-empty, evaluates automatic closing). The destination side has no equivalent service:
 * the moved stops are appended after the last `sequence_order` already there, without resimulating the
 * route (D8-style decision, scoped to this ticket — see the PR description for the tradeoff).
 */
@Injectable()
export class RouteBatchReassignmentService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly batchExit: BatchExitService,
        private readonly capacity: RouteCapacityService,
        private readonly events: EventEmitter2,
    ) {}

    async reassign(originBatchId: number, dto: ReassignRouteBatchDto, actorUserId: number): Promise<ReassignRouteBatchResponseDto> {
        const result = await this.dataSource.transaction(async (manager) => this.apply(manager, originBatchId, dto, actorUserId));

        this.events.emit(ROUTE_BATCH_REASSIGNED_EVENT, result.event);
        return result.response;
    }

    private async apply(
        manager: EntityManager,
        originBatchId: number,
        dto: ReassignRouteBatchDto,
        actorUserId: number,
    ): Promise<{ response: ReassignRouteBatchResponseDto; event: RouteBatchReassignedEvent }> {
        if (originBatchId === dto.targetBatchId) {
            throw new RouteBatchReassignConflictException('ROUTE_BATCH_SAME_BATCH', 'The destination batch must be different from the origin batch.');
        }

        const batches: BatchRow[] = await manager.query(
            `SELECT route_batch_id AS id, status, version, driver_id, vehicle_id
               FROM route_batches WHERE route_batch_id = ANY($1::int[]) ORDER BY route_batch_id FOR UPDATE`,
            [[originBatchId, dto.targetBatchId]],
        );
        const origin = batches.find((batch) => batch.id === originBatchId);
        const target = batches.find((batch) => batch.id === dto.targetBatchId);
        if (!origin || !target) throw new RouteBatchNotFoundException();
        if (origin.status !== RouteBatchStatusEnum.IN_EXECUTION || target.status !== RouteBatchStatusEnum.IN_EXECUTION) {
            throw new RouteBatchReassignConflictException('ROUTE_BATCH_NOT_IN_EXECUTION', 'Both route batches must be in_execution to reassign stops between them.');
        }
        if (target.vehicle_id === null || target.driver_id === null || origin.driver_id === null) {
            throw new RouteBatchReassignConflictException('ROUTE_BATCH_VEHICLE_REQUIRED', 'Both route batches must have a driver, and the destination a vehicle, assigned.');
        }
        if (origin.version !== dto.version) {
            throw new RouteBatchReassignConflictException('ROUTE_BATCH_VERSION_CONFLICT', 'The origin route batch changed. Reload it before reassigning.');
        }
        if (target.version !== dto.targetVersion) {
            throw new RouteBatchReassignConflictException('ROUTE_BATCH_VERSION_CONFLICT', 'The destination route batch changed. Reload it before reassigning.');
        }

        const [reason]: { reschedule_reason_id: number }[] = await manager.query(
            `SELECT reschedule_reason_id FROM reschedule_reasons WHERE code = $1 AND active = TRUE AND deleted_at IS NULL`,
            [dto.reasonCode],
        );
        if (!reason) throw new RescheduleReasonInvalidException(dto.reasonCode);

        const requested: DispatchRow[] = await manager.query(
            `SELECT d.dispatch_id, d.route_batch_id, s.name AS status
               FROM dispatches d JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
              WHERE d.dispatch_id = ANY($1::int[])
              ORDER BY d.dispatch_id FOR UPDATE OF d`,
            [dto.dispatchIds],
        );
        const byId = new Map(requested.map((row) => [row.dispatch_id, row]));
        for (const dispatchId of dto.dispatchIds) {
            const row = byId.get(dispatchId);
            if (!row) throw new DispatchNotFoundException();
            if (row.route_batch_id !== originBatchId) {
                throw new RouteBatchReassignConflictException('DISPATCH_NOT_IN_BATCH', `Dispatch ${dispatchId} does not belong to route batch ${originBatchId}.`);
            }
            if (row.status !== DispatchStatusEnum.OUT_FOR_DELIVERY) {
                throw new RouteBatchReassignConflictException('DISPATCH_NOT_OUT_FOR_DELIVERY', `Dispatch ${dispatchId} is ${row.status}, not out_for_delivery; it cannot be reassigned.`);
            }
        }

        // Origin side: BatchExitService.leave() is called once per dispatch, carrying the updated version/
        // stops forward manually — it always reports batchVersion as locked.version+1, so a stale `locked`
        // across calls would report the wrong value for every dispatch after the first (the DB row itself
        // is always correct either way, since it increments by a plain `version = version + 1`).
        let locked: LockedBatch = (await this.batchExit.lock(manager, originBatchId))!;
        let originClosed = false;
        for (const dispatchId of dto.dispatchIds) {
            const result = await this.batchExit.leave(manager, locked, dispatchId, {
                actorUserId, reason: dto.reasonCode, metadata: { toBatchId: dto.targetBatchId },
            });
            originClosed = result.closed;
            locked = { ...locked, version: result.batchVersion, stops: locked.stops.filter((stop) => stop.dispatchId !== dispatchId) };
        }

        // Destination side: lock its current stops to compute the next sequence_order safely, then append.
        const targetStops: { sequence_order: number | null }[] = await manager.query(
            `SELECT sequence_order FROM dispatches WHERE route_batch_id = $1 ORDER BY dispatch_id FOR UPDATE`,
            [dto.targetBatchId],
        );
        let nextSequence = targetStops.reduce((max, stop) => Math.max(max, stop.sequence_order ?? 0), 0);
        for (const dispatchId of dto.dispatchIds) {
            nextSequence += 1;
            await manager.query(
                `UPDATE dispatches SET route_batch_id = $2, sequence_order = $3, version = version + 1, updated_at = NOW() WHERE dispatch_id = $1`,
                [dispatchId, dto.targetBatchId, nextSequence],
            );
        }

        await this.capacity.assertAssignable(dto.targetBatchId, target.vehicle_id, manager);

        // TypeORM answers UPDATE ... RETURNING with [rows, affectedCount], not with the rows (see
        // route-batch-closing.service.ts) — the inner array is where the returned row actually is.
        const [[{ version: toVersion }]]: [{ version: number }[], number] = await manager.query(
            `UPDATE route_batches SET version = version + $2, updated_at = NOW() WHERE route_batch_id = $1 RETURNING version`,
            [dto.targetBatchId, dto.dispatchIds.length],
        );
        for (const dispatchId of dto.dispatchIds) {
            await manager.query(
                `INSERT INTO route_batch_events (route_batch_id, dispatch_id, event_type, actor_user_id, actor_type, reason, metadata)
                 VALUES ($1, $2, 'order_added', $3, 'user', $4, $5::jsonb)`,
                [dto.targetBatchId, dispatchId, actorUserId, dto.reasonCode, JSON.stringify({ fromBatchId: originBatchId })],
            );
        }

        const [zoneRow]: ZoneRow[] = await manager.query(
            `SELECT dz.name FROM route_batches rb LEFT JOIN delivery_zones dz ON dz.delivery_zone_id = rb.delivery_zone_id WHERE rb.route_batch_id = $1`,
            [dto.targetBatchId],
        );

        const response: ReassignRouteBatchResponseDto = {
            fromBatchId: originBatchId,
            toBatchId: dto.targetBatchId,
            movedDispatchIds: dto.dispatchIds,
            fromVersion: locked.version,
            toVersion,
            fromBatchClosed: originClosed,
        };
        const event: RouteBatchReassignedEvent = {
            fromBatchId: originBatchId,
            toBatchId: dto.targetBatchId,
            fromDriverId: origin.driver_id!,
            toDriverId: target.driver_id!,
            dispatchIds: dto.dispatchIds,
            fromVersion: locked.version,
            toVersion,
            zoneName: zoneRow?.name ?? null,
        };
        return { response, event };
    }
}
