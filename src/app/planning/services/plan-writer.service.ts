import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { isUniqueViolation } from '../../../shared/orm/unique-violation.js';
import { DispatchStatusEnum, RouteBatchStatusEnum } from '../../../shared/enums/index.js';
import { RouteBatch } from '../../../modules/dispatch/route-batches/entities/route-batch.entity.js';
import { RouteBatchEvent } from '../../../modules/dispatch/route-batches/entities/route-batch-event.entity.js';
import { DispatchEvent } from '../../../modules/dispatch/dispatch-events/entities/dispatch-event.entity.js';
import { RouteBatchReviewerService } from '../../../modules/dispatch/route-batches/services/route-batch-reviewer.service.js';
import type { ProposedBatch, ProposedInsertion } from '../domain/plan-types.js';

export interface WriteContext {
    trigger: 'scheduled' | 'manual';
    /** `plan-generation@2026-10-13T08:30`, or `null` when the run was manual. */
    occurrence: string | null;
}

export interface WrittenBatch {
    /** `null` when every order had changed meanwhile and nothing was created. */
    routeBatchId: number | null;
    vehicleId: number | null;
    plannedDispatchIds: number[];
    /** Orders left out because they were no longer `pending`/`rescheduled`, or a coordinator took them. */
    skippedDispatchIds: number[];
}

export interface WrittenInsertion {
    routeBatchId: number;
    /** `true` when something was written. */
    applied: boolean;
    /** The batch changed after the plan was computed (version, status or stops): nothing was written. */
    stale: boolean;
    insertedDispatchIds: number[];
    skippedDispatchIds: number[];
}

interface LockedDispatch {
    dispatch_id: number;
    status: string;
    route_batch_id: number | null;
    reserved: boolean;
}

interface BatchStopRow {
    dispatch_id: number;
    sequence_order: number | null;
    window_start: Date | null;
}

/**
 * Persists what the planner proposed, one transaction per batch (plan §2.6 step 7 and §2.7): either a
 * new provisional batch, or late orders inserted into an open one with the whole batch renumbered in
 * two steps (D-32). The batch reviewer (D-42) is decided in the same transaction as the creation, so
 * a batch never exists without that decision.
 */
@Injectable()
export class PlanWriterService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly reviewer: RouteBatchReviewerService,
    ) {}

    async writeNewBatch(proposal: ProposedBatch, context: WriteContext): Promise<WrittenBatch> {
        return await this.dataSource.transaction((manager) => this.createBatch(manager, proposal, context));
    }

    async writeInsertion(insertion: ProposedInsertion, context: WriteContext): Promise<WrittenInsertion> {
        return await this.dataSource.transaction((manager) => this.insertIntoBatch(manager, insertion, context));
    }

    private async createBatch(manager: EntityManager, proposal: ProposedBatch, context: WriteContext): Promise<WrittenBatch> {
        const wanted = proposal.stops.map((stop) => stop.dispatchId);
        const locked = await this.lockDispatches(manager, wanted);
        const plannable = plannableIds(locked);

        const stops = proposal.stops.filter((stop) => plannable.has(stop.dispatchId));
        const skippedDispatchIds = wanted.filter((id) => !plannable.has(id));
        if (stops.length === 0) {
            return { routeBatchId: null, vehicleId: null, plannedDispatchIds: [], skippedDispatchIds };
        }

        const { routeBatchId, vehicleId } = await this.insertBatch(manager, proposal);

        // Renumber 1..n over the orders that were really taken, so a skipped order leaves no gap.
        const ids = stops.map((stop) => stop.dispatchId);
        await this.assignToBatch(manager, routeBatchId, stops.map((stop, index) => ({
            dispatchId: stop.dispatchId,
            sequence: index + 1,
            windowStart: stop.windowStart,
            windowEnd: stop.windowEnd,
        })));

        await this.recordStatusEvents(manager, locked, ids, routeBatchId, context);

        const batchEvents = manager.getRepository(RouteBatchEvent);
        await batchEvents.save(batchEvents.create({
            routeBatchId,
            dispatchId: null,
            eventType: 'created',
            actorUserId: null,
            actorType: 'system',
            reason: null,
            metadata: {
                zoneId: proposal.zoneId,
                zoneCode: proposal.zoneCode,
                zoneName: proposal.zoneName,
                vehicleId,
                proposedDriverId: proposal.proposedDriverId,
                stops: ids.length,
                skippedDispatchIds,
                splitReason: proposal.splitReason,
                rescheduledDispatchIds: proposal.rescheduledDispatchIds.filter((id) => plannable.has(id)),
                trigger: context.trigger,
                occurrence: context.occurrence,
            },
        }));

        // D-42: inside the same transaction, so the batch is never visible without its reviewer decision.
        await this.reviewer.assignReviewer(routeBatchId, { manager });

        return { routeBatchId, vehicleId, plannedDispatchIds: ids, skippedDispatchIds };
    }

    private async insertIntoBatch(manager: EntityManager, insertion: ProposedInsertion, context: WriteContext): Promise<WrittenInsertion> {
        const { routeBatchId } = insertion;
        const newStops = insertion.stops.filter((stop) => stop.isNew);
        const staleResult: WrittenInsertion = {
            routeBatchId, applied: false, stale: true, insertedDispatchIds: [], skippedDispatchIds: newStops.map((s) => s.dispatchId),
        };

        const [batch]: { status: string; version: number }[] = await manager.query(
            `SELECT status, version FROM route_batches WHERE route_batch_id = $1 FOR UPDATE`,
            [routeBatchId],
        );
        if (!batch || batch.status !== RouteBatchStatusEnum.PROVISIONAL || batch.version !== insertion.expectedVersion) {
            return staleResult;
        }

        // The batch must still be what the plan saw: same orders in the same sequence.
        const current: BatchStopRow[] = await manager.query(
            `SELECT dispatch_id, sequence_order, scheduled_window_start AS window_start
               FROM dispatches
              WHERE route_batch_id = $1
              ORDER BY dispatch_id
                FOR UPDATE`,
            [routeBatchId],
        );
        const expected = insertion.stops.filter((stop) => !stop.isNew);
        const sameStops = current.length === expected.length
            && expected.every((stop) => current.some((row) => row.dispatch_id === stop.dispatchId && row.sequence_order === stop.previousSequence));
        if (!sameStops) return staleResult;

        const locked = await this.lockDispatches(manager, newStops.map((stop) => stop.dispatchId));
        const plannable = plannableIds(locked);
        const skippedDispatchIds = newStops.map((stop) => stop.dispatchId).filter((id) => !plannable.has(id));
        const finalStops = insertion.stops.filter((stop) => !stop.isNew || plannable.has(stop.dispatchId));
        const insertedDispatchIds = finalStops.filter((stop) => stop.isNew).map((stop) => stop.dispatchId);
        if (insertedDispatchIds.length === 0) {
            return { routeBatchId, applied: false, stale: false, insertedDispatchIds: [], skippedDispatchIds };
        }

        // D-32, step 1: park every sequence on its negative so the unique index never sees two equal ones.
        await manager.query(
            `UPDATE dispatches SET sequence_order = -sequence_order
              WHERE route_batch_id = $1 AND sequence_order IS NOT NULL`,
            [routeBatchId],
        );

        // Step 2: the final numbers. Existing stops are bumped only when their place or window changed.
        const previousWindow = new Map(current.map((row) => [row.dispatch_id, row.window_start]));
        const numbered = finalStops.map((stop, index) => ({ ...stop, sequence: index + 1 }));
        const existing = numbered.filter((stop) => !stop.isNew);
        if (existing.length > 0) {
            const bump = existing.map((stop) => {
                const before = previousWindow.get(stop.dispatchId) ?? null;
                const windowChanged = stop.windowStart !== null
                    && (before === null || before.getTime() !== stop.windowStart.getTime());
                return stop.sequence !== stop.previousSequence || windowChanged;
            });
            await manager.query(
                `UPDATE dispatches AS d
                    SET sequence_order = v.seq,
                        scheduled_window_start = COALESCE(v.ws, d.scheduled_window_start),
                        scheduled_window_end = COALESCE(v.we, d.scheduled_window_end),
                        version = d.version + CASE WHEN v.bump THEN 1 ELSE 0 END,
                        updated_at = CASE WHEN v.bump THEN NOW() ELSE d.updated_at END
                   FROM (SELECT unnest($1::int[]) AS id, unnest($2::int[]) AS seq,
                                unnest($3::timestamptz[]) AS ws, unnest($4::timestamptz[]) AS we,
                                unnest($5::boolean[]) AS bump) AS v
                  WHERE d.dispatch_id = v.id`,
                [
                    existing.map((stop) => stop.dispatchId),
                    existing.map((stop) => stop.sequence),
                    existing.map((stop) => stop.windowStart),
                    existing.map((stop) => stop.windowEnd),
                    bump,
                ],
            );
        }

        const added = numbered.filter((stop) => stop.isNew);
        await this.assignToBatch(manager, routeBatchId, added.map((stop) => ({
            dispatchId: stop.dispatchId, sequence: stop.sequence, windowStart: stop.windowStart, windowEnd: stop.windowEnd,
        })));

        await manager.query(
            `UPDATE route_batches SET version = version + 1, updated_at = NOW() WHERE route_batch_id = $1`,
            [routeBatchId],
        );

        await this.recordStatusEvents(manager, locked, insertedDispatchIds, routeBatchId, context, new Map(added.map((s) => [s.dispatchId, s.sequence])));

        const shiftedDispatchIds = existing
            .filter((stop) => stop.sequence !== stop.previousSequence)
            .map((stop) => stop.dispatchId);
        const batchEvents = manager.getRepository(RouteBatchEvent);
        await batchEvents.save(added.map((stop) => batchEvents.create({
            routeBatchId,
            dispatchId: stop.dispatchId,
            eventType: 'order_added',
            actorUserId: null,
            actorType: 'system',
            reason: null,
            metadata: {
                dispatchId: stop.dispatchId,
                position: stop.sequence,
                previousSequence: stop.previousSequence,
                newSequence: stop.sequence,
                shiftedDispatchIds,
                zoneId: insertion.zoneId,
                zoneCode: insertion.zoneCode,
                zoneName: insertion.zoneName,
                batchVersion: insertion.expectedVersion + 1,
                trigger: context.trigger,
                occurrence: context.occurrence,
            },
        })));

        return { routeBatchId, applied: true, stale: false, insertedDispatchIds, skippedDispatchIds };
    }

    /** Puts the orders in the batch with their sequence and window, as `in_planning` (D-09: moving bumps the version). */
    private async assignToBatch(
        manager: EntityManager,
        routeBatchId: number,
        stops: { dispatchId: number; sequence: number; windowStart: Date | null; windowEnd: Date | null }[],
    ): Promise<void> {
        if (stops.length === 0) return;
        await manager.query(
            `UPDATE dispatches AS d
                SET route_batch_id = $1,
                    sequence_order = v.seq,
                    scheduled_window_start = COALESCE(v.ws, d.scheduled_window_start),
                    scheduled_window_end = COALESCE(v.we, d.scheduled_window_end),
                    dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $6),
                    version = d.version + 1,
                    updated_at = NOW()
               FROM (SELECT unnest($2::int[]) AS id, unnest($3::int[]) AS seq,
                            unnest($4::timestamptz[]) AS ws, unnest($5::timestamptz[]) AS we) AS v
              WHERE d.dispatch_id = v.id`,
            [
                routeBatchId,
                stops.map((stop) => stop.dispatchId),
                stops.map((stop) => stop.sequence),
                stops.map((stop) => stop.windowStart),
                stops.map((stop) => stop.windowEnd),
                DispatchStatusEnum.IN_PLANNING,
            ],
        );
    }

    private async recordStatusEvents(
        manager: EntityManager,
        locked: LockedDispatch[],
        ids: number[],
        routeBatchId: number,
        context: WriteContext,
        sequences?: Map<number, number>,
    ): Promise<void> {
        const statusByDispatch = new Map(locked.map((row) => [row.dispatch_id, row.status]));
        const dispatchEvents = manager.getRepository(DispatchEvent);
        await dispatchEvents.save(ids.map((dispatchId, index) => dispatchEvents.create({
            dispatchId,
            eventType: 'status_changed',
            detail: 'Planned into a provisional batch.',
            actorUserId: null,
            actorType: 'system',
            reason: null,
            metadata: {
                from: statusByDispatch.get(dispatchId),
                to: DispatchStatusEnum.IN_PLANNING,
                routeBatchId,
                sequenceOrder: sequences?.get(dispatchId) ?? index + 1,
                trigger: context.trigger,
                occurrence: context.occurrence,
            },
        })));
    }

    private async lockDispatches(manager: EntityManager, ids: number[]): Promise<LockedDispatch[]> {
        if (ids.length === 0) return [];
        return await manager.query(
            `SELECT d.dispatch_id, s.name AS status, d.route_batch_id,
                    EXISTS (SELECT 1 FROM dispatch_reservations r
                             WHERE r.dispatch_id = d.dispatch_id AND r.expires_at > NOW()) AS reserved
               FROM dispatches d
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
              WHERE d.dispatch_id = ANY($1)
              ORDER BY d.dispatch_id
                FOR UPDATE OF d`,
            [ids],
        );
    }

    /**
     * Inserts the batch with the proposed vehicle; if another batch took that vehicle for the day in
     * the meantime (`uq_route_batches_vehicle_shift_date`), tries the larger vehicles that also fit.
     * Each attempt runs in a savepoint so a failed insert does not poison the transaction.
     */
    private async insertBatch(manager: EntityManager, proposal: ProposedBatch): Promise<{ routeBatchId: number; vehicleId: number }> {
        const options = [proposal.vehicleId, ...proposal.alternativeVehicleIds];
        for (let attempt = 0; attempt < options.length; attempt++) {
            const vehicleId = options[attempt];
            try {
                const routeBatchId = await manager.transaction(async (savepoint) => {
                    const repo = savepoint.getRepository(RouteBatch);
                    const saved = await repo.save(repo.create({
                        status: RouteBatchStatusEnum.PROVISIONAL,
                        version: 0,
                        shiftDate: proposal.shiftDate,
                        deliveryZoneId: proposal.zoneId,
                        originWarehouseId: proposal.warehouseId,
                        vehicleId,
                        driverId: null,
                        proposedDriverId: proposal.proposedDriverId,
                    }));
                    return saved.id;
                });
                return { routeBatchId, vehicleId };
            } catch (error) {
                if (!isUniqueViolation(error) || attempt === options.length - 1) throw error;
            }
        }
        throw new Error('unreachable');
    }
}

/** Orders still `pending`/`rescheduled`, without batch and not being edited by a coordinator. */
function plannableIds(locked: LockedDispatch[]): Set<number> {
    return new Set(
        locked
            .filter((row) => (row.status === DispatchStatusEnum.PENDING || row.status === DispatchStatusEnum.RESCHEDULED)
                && row.route_batch_id === null && !row.reserved)
            .map((row) => row.dispatch_id),
    );
}
