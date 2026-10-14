import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { isUniqueViolation } from '../../../shared/orm/unique-violation.js';
import { DispatchStatusEnum, RouteBatchStatusEnum } from '../../../shared/enums/index.js';
import { RouteBatch } from '../../../modules/dispatch/route-batches/entities/route-batch.entity.js';
import { RouteBatchEvent } from '../../../modules/dispatch/route-batches/entities/route-batch-event.entity.js';
import { DispatchEvent } from '../../../modules/dispatch/dispatch-events/entities/dispatch-event.entity.js';
import { RouteBatchReviewerService } from '../../../modules/dispatch/route-batches/services/route-batch-reviewer.service.js';
import type { ProposedBatch } from '../domain/plan-types.js';

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

interface LockedDispatch {
    dispatch_id: number;
    status: string;
    route_batch_id: number | null;
    reserved: boolean;
}

/**
 * Persists one proposed batch in its own transaction (plan §2.6, step 7): creates the provisional
 * batch, moves its orders to `in_planning` with their sequence, records both histories and gives the
 * batch its reviewer (D-42) before committing, so a batch never exists without that decision.
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

    private async createBatch(manager: EntityManager, proposal: ProposedBatch, context: WriteContext): Promise<WrittenBatch> {
        const wanted = proposal.stops.map((stop) => stop.dispatchId);
        const locked = await this.lockDispatches(manager, wanted);

        // Recheck under the lock: between planning and now a coordinator may have taken the order, or an
        // intake message may have changed it.
        const plannable = new Set(
            locked
                .filter((row) => (row.status === DispatchStatusEnum.PENDING || row.status === DispatchStatusEnum.RESCHEDULED)
                    && row.route_batch_id === null && !row.reserved)
                .map((row) => row.dispatch_id),
        );
        const stops = proposal.stops.filter((stop) => plannable.has(stop.dispatchId));
        const skippedDispatchIds = wanted.filter((id) => !plannable.has(id));
        if (stops.length === 0) {
            return { routeBatchId: null, vehicleId: null, plannedDispatchIds: [], skippedDispatchIds };
        }

        const { routeBatchId, vehicleId } = await this.insertBatch(manager, proposal);

        // Renumber 1..n over the orders that were really taken, so a skipped order leaves no gap.
        const ids = stops.map((stop) => stop.dispatchId);
        await manager.query(
            `UPDATE dispatches AS d
                SET route_batch_id = $1,
                    sequence_order = v.seq,
                    dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $4),
                    version = d.version + 1,
                    updated_at = NOW()
               FROM (SELECT unnest($2::int[]) AS id, unnest($3::int[]) AS seq) AS v
              WHERE d.dispatch_id = v.id`,
            [routeBatchId, ids, ids.map((_, index) => index + 1), DispatchStatusEnum.IN_PLANNING],
        );

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
                sequenceOrder: index + 1,
                trigger: context.trigger,
                occurrence: context.occurrence,
            },
        })));

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

    private async lockDispatches(manager: EntityManager, ids: number[]): Promise<LockedDispatch[]> {
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
