import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { DispatchEvent } from '../../../modules/dispatch/dispatch-events/entities/dispatch-event.entity.js';
import { RouteBatchEvent } from '../../../modules/dispatch/route-batches/entities/route-batch-event.entity.js';
import { DispatchStatusEnum, RouteBatchStatusEnum } from '../../../shared/enums/index.js';
import type { PlanVehicle } from '../../planning/domain/plan-types.js';
import type { SimParams } from '../../planning/domain/route-simulation.js';
import type { CutoffGroup } from '../domain/cutoff-groups.js';
import type { CutoffBatchPlan, CutoffStop } from '../domain/cutoff-types.js';
import {
    findDuplicatedDispatches,
    validateCutoffBatch,
    type BatchFacts,
    type CutoffFailureCode,
    type CutoffIssue,
    type CutoffValidation,
    type CutoffWarningCode,
    type StopFacts,
} from '../domain/cutoff-validation.js';

export interface CutoffWriteContext {
    trigger: 'scheduled' | 'manual';
    /** `route-cutoff@2026-10-13T15:00`, or `null` when the run was manual. */
    occurrence: string | null;
    fleet: PlanVehicle[];
    params: SimParams;
    /** Every stop the cutoff read, by dispatch id: capacity data and promised window. */
    stopsById: Map<number, CutoffStop>;
}

export interface CutoffBatchOutcome {
    routeBatchId: number;
    status: RouteBatchStatusEnum.PENDING_FINAL_REVIEW | RouteBatchStatusEnum.PROVISIONAL;
    failures: Array<CutoffIssue>;
    warnings: Array<CutoffIssue<CutoffWarningCode>>;
    vehicleId: number | null;
    stops: number;
}

export interface CutoffGroupResult {
    key: string;
    /** `stale`: something changed while the cutoff was computing; nothing of the group was reorganized. */
    status: 'applied' | 'stale';
    batches: CutoffBatchOutcome[];
    /** Batches born by splitting. */
    createdBatchIds: number[];
    /** Batches that hold the orders with an open window. */
    remnantBatchIds: number[];
    cancelledBatchIds: number[];
    releasedDispatchIds: number[];
    remnantDispatchIds: number[];
    staleReasons: Array<CutoffIssue>;
}

interface LockedBatch {
    route_batch_id: number;
    status: string;
    version: number;
    vehicle_id: number | null;
    proposed_driver_id: number | null;
}

interface LockedDispatch {
    dispatch_id: number;
    status: string;
    version: number;
    route_batch_id: number | null;
    sequence_order: number | null;
    has_destination: boolean;
}

/** Failures that mean "the data moved under the cutoff": the group is left exactly as it was. */
const STALE_CODES: ReadonlySet<CutoffFailureCode> = new Set<CutoffFailureCode>([
    'batch_not_found',
    'batch_version_changed',
    'dispatch_not_found',
    'dispatch_version_changed',
    'dispatch_status_changed',
    'dispatch_in_other_batch',
]);

/**
 * Persists the cutoff of one group (day, zone, warehouse) in one transaction (ST-51.3). It locks the
 * batches and orders, validates what the proposal would leave, and only then reorganizes: the vehicle
 * and driver unique indexes are not deferrable, so every vehicle that changes hands is released first.
 *
 * Versions are bumped by hand and only for what changed (D-09). Every merge, split, move, release and
 * validation leaves an append-only event.
 */
@Injectable()
export class RouteCutoffWriterService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async applyGroup(group: CutoffGroup, context: CutoffWriteContext): Promise<CutoffGroupResult> {
        return await this.dataSource.transaction((manager) => this.apply(manager, group, context));
    }

    private async apply(manager: EntityManager, group: CutoffGroup, context: CutoffWriteContext): Promise<CutoffGroupResult> {
        const { plan } = group;
        const result: CutoffGroupResult = {
            key: group.key, status: 'applied', batches: [], createdBatchIds: [], remnantBatchIds: [],
            cancelledBatchIds: [], releasedDispatchIds: [], remnantDispatchIds: [], staleReasons: [],
        };

        const duplicated = findDuplicatedDispatches(plan.batches);
        if (duplicated.length > 0) {
            throw new Error(`The cutoff proposal puts dispatches ${duplicated.join(', ')} in two batches.`);
        }

        const batches = await this.lockBatches(manager, group.batchIds);
        const dispatchIds = this.involvedDispatchIds(group);
        const dispatches = await this.lockDispatches(manager, group.batchIds, dispatchIds);

        // 1. Validate what each batch would be, against the data as it is now.
        const validations = new Map<CutoffBatchPlan, CutoffValidation>();
        for (const batchPlan of plan.batches) {
            const facts = await this.buildFacts(manager, group, batchPlan, batches, dispatches, context);
            validations.set(batchPlan, validateCutoffBatch(facts, context.params));
        }
        const staleReasons = [...validations.values()]
            .flatMap((validation) => validation.failures)
            .filter((failure) => STALE_CODES.has(failure.code));

        if (staleReasons.length > 0) {
            // Nothing is moved: the next run (or the coordinator) starts from the data as it is.
            result.status = 'stale';
            result.staleReasons = staleReasons;
            for (const [batchPlan, validation] of validations) {
                if (batchPlan.routeBatchId === null) continue;
                result.batches.push(outcome(batchPlan.routeBatchId, batchPlan, validation, false));
                await this.recordValidationEvent(manager, batchPlan.routeBatchId, validation, context, { stale: true });
            }
            return result;
        }

        // 2. Reorganize. Free what changes hands first, then place.
        const absorbed = plan.batches.flatMap((batchPlan) => batchPlan.absorbedBatchIds);
        const emptied = plan.cancelledBatchIds.filter((id) => !absorbed.includes(id));
        // Cancelled first: a cancelled batch no longer holds its vehicle for the unique index.
        if (emptied.length + absorbed.length > 0) await this.cancelBatches(manager, [...emptied, ...absorbed]);
        const changingVehicle = plan.batches
            .filter((batchPlan) => batchPlan.routeBatchId !== null)
            .filter((batchPlan) => batches.get(batchPlan.routeBatchId!)?.vehicle_id !== batchPlan.vehicleId)
            .map((batchPlan) => batchPlan.routeBatchId!);
        if (changingVehicle.length > 0) {
            await manager.query(`UPDATE route_batches SET vehicle_id = NULL WHERE route_batch_id = ANY($1)`, [changingVehicle]);
        }
        // Every stop of the group gives up its place before taking the final one (D-32).
        if (dispatchIds.length > 0) {
            await manager.query(`UPDATE dispatches SET sequence_order = NULL WHERE dispatch_id = ANY($1)`, [dispatchIds]);
        }

        const released = new Set(plan.released.map((release) => release.dispatchId));
        const remnantsBySource = new Map(plan.remnants.map((remnant) => [remnant.sourceBatchId, remnant]));
        const finalIdOf = new Map<string, number>(); // newRef → id
        const moves: Array<{ dispatchId: number; to: number; sequence: number; reason: string; from: number | null; version: number }> = [];

        // 2a. Batches (existing rows updated, new rows inserted) with their final status.
        for (const batchPlan of plan.batches) {
            const validation = validations.get(batchPlan)!;
            const passed = validation.passed;
            const status = passed ? RouteBatchStatusEnum.PENDING_FINAL_REVIEW : RouteBatchStatusEnum.PROVISIONAL;
            let routeBatchId: number;

            if (batchPlan.routeBatchId === null) {
                const [row]: { route_batch_id: number }[] = await manager.query(
                    `INSERT INTO route_batches
                        (status, version, shift_date, delivery_zone_id, origin_warehouse_id, vehicle_id,
                         proposed_driver_id, reviewer_user_id)
                     VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8)
                     RETURNING route_batch_id`,
                    [status, passed ? 1 : 0, batchPlan.shiftDate, batchPlan.zoneId, batchPlan.warehouseId,
                        batchPlan.vehicleId, batchPlan.proposedDriverId, batchPlan.reviewerUserId],
                );
                routeBatchId = row.route_batch_id;
                finalIdOf.set(batchPlan.newRef!, routeBatchId);
                result.createdBatchIds.push(routeBatchId);
            } else {
                routeBatchId = batchPlan.routeBatchId;
                const before = batches.get(routeBatchId)!;
                const changed = before.vehicle_id !== batchPlan.vehicleId
                    || batchPlan.absorbedBatchIds.length > 0
                    || remnantsBySource.has(routeBatchId)
                    || plan.released.some((release) => release.fromBatchId === routeBatchId)
                    || batchPlan.stops.some((stop) => {
                        const read = context.stopsById.get(stop.dispatchId)!;
                        const current = dispatches.get(stop.dispatchId)!;
                        return current.route_batch_id !== routeBatchId || read.sequence !== stop.sequence;
                    });
                const bump = changed || passed ? 1 : 0;
                await manager.query(
                    `UPDATE route_batches
                        SET vehicle_id = $2, status = $3, version = version + $4, updated_at = NOW()
                      WHERE route_batch_id = $1`,
                    [routeBatchId, batchPlan.vehicleId, status, bump],
                );
            }

            for (const stop of batchPlan.stops) {
                const current = dispatches.get(stop.dispatchId)!;
                moves.push({
                    dispatchId: stop.dispatchId,
                    to: routeBatchId,
                    sequence: stop.sequence,
                    reason: current.route_batch_id === routeBatchId ? 'resequenced' : 'moved',
                    from: current.route_batch_id,
                    version: stop.version,
                });
            }
            result.batches.push(outcome(routeBatchId, batchPlan, validation, true));
        }

        // 2b. Remnants for the orders with an open window: provisional, no vehicle, same zone and day.
        const remnantIds: number[] = [];
        for (const remnant of plan.remnants) {
            const [row]: { route_batch_id: number }[] = await manager.query(
                `INSERT INTO route_batches
                    (status, version, shift_date, delivery_zone_id, origin_warehouse_id, vehicle_id,
                     proposed_driver_id, reviewer_user_id)
                 VALUES ($1, 0, $2::date, $3, $4, NULL, NULL, $5)
                 RETURNING route_batch_id`,
                [RouteBatchStatusEnum.PROVISIONAL, remnant.shiftDate, remnant.zoneId, remnant.warehouseId, remnant.reviewerUserId],
            );
            remnantIds.push(row.route_batch_id);
            result.remnantBatchIds.push(row.route_batch_id);
            result.remnantDispatchIds.push(...remnant.dispatchIds);
            const ordered = [...remnant.dispatchIds].sort(
                (a, b) => context.stopsById.get(a)!.sequence - context.stopsById.get(b)!.sequence,
            );
            ordered.forEach((dispatchId, index) => moves.push({
                dispatchId,
                to: row.route_batch_id,
                sequence: index + 1,
                reason: 'window_open',
                from: remnant.sourceBatchId,
                version: context.stopsById.get(dispatchId)!.version,
            }));
        }

        // 2c. Final place of every stop. A stop is bumped (D-09) only if its batch or place changed.
        const bumped = moves.filter((move) => {
            const current = dispatches.get(move.dispatchId)!;
            const read = context.stopsById.get(move.dispatchId)!;
            return current.route_batch_id !== move.to || read.sequence !== move.sequence;
        });
        if (moves.length > 0) {
            const bumpIds = new Set(bumped.map((move) => move.dispatchId));
            await manager.query(
                `UPDATE dispatches AS d
                    SET route_batch_id = v.batch, sequence_order = v.seq,
                        version = d.version + CASE WHEN v.bump THEN 1 ELSE 0 END,
                        updated_at = CASE WHEN v.bump THEN NOW() ELSE d.updated_at END
                   FROM (SELECT unnest($1::int[]) AS id, unnest($2::int[]) AS batch, unnest($3::int[]) AS seq,
                                unnest($4::boolean[]) AS bump) AS v
                  WHERE d.dispatch_id = v.id`,
                [
                    moves.map((move) => move.dispatchId),
                    moves.map((move) => move.to),
                    moves.map((move) => move.sequence),
                    moves.map((move) => bumpIds.has(move.dispatchId)),
                ],
            );
        }

        // 2d. Orders without promise go back to `pending` (§5.3): the generator tries the next viable date.
        const releasedFrom = new Map(plan.released.map((release) => [release.dispatchId, release.fromBatchId]));
        if (released.size > 0) {
            await manager.query(
                `UPDATE dispatches
                    SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $2),
                        route_batch_id = NULL, sequence_order = NULL, version = version + 1, updated_at = NOW()
                  WHERE dispatch_id = ANY($1)`,
                [[...released], DispatchStatusEnum.PENDING],
            );
            result.releasedDispatchIds.push(...released);
        }

        // Batches left with only the orders that wait (no firm stop) or that lost an order.
        for (const untouched of plan.untouched) {
            const bump = plan.released.some((release) => release.fromBatchId === untouched.routeBatchId);
            if (bump) {
                await manager.query(`UPDATE route_batches SET version = version + 1, updated_at = NOW() WHERE route_batch_id = $1`, [untouched.routeBatchId]);
            }
        }
        result.cancelledBatchIds.push(...emptied, ...absorbed);

        await this.recordEvents(manager, group, context, {
            validations, finalIdOf, remnantIds, emptied, released: releasedFrom, moves: bumped,
        });
        return result;
    }

    private involvedDispatchIds(group: CutoffGroup): number[] {
        const ids = new Set<number>();
        for (const batch of group.plan.batches) for (const stop of batch.stops) ids.add(stop.dispatchId);
        for (const remnant of group.plan.remnants) for (const id of remnant.dispatchIds) ids.add(id);
        for (const release of group.plan.released) ids.add(release.dispatchId);
        for (const untouched of group.plan.untouched) for (const id of untouched.openDispatchIds) ids.add(id);
        return [...ids];
    }

    private async lockBatches(manager: EntityManager, ids: number[]): Promise<Map<number, LockedBatch>> {
        const rows: LockedBatch[] = await manager.query(
            `SELECT route_batch_id, status, version, vehicle_id, proposed_driver_id
               FROM route_batches WHERE route_batch_id = ANY($1) ORDER BY route_batch_id FOR UPDATE`,
            [ids],
        );
        return new Map(rows.map((row) => [row.route_batch_id, row]));
    }

    private async lockDispatches(manager: EntityManager, batchIds: number[], dispatchIds: number[]): Promise<Map<number, LockedDispatch>> {
        const rows: LockedDispatch[] = await manager.query(
            `SELECT d.dispatch_id, s.name AS status, d.version, d.route_batch_id, d.sequence_order,
                    (d.delivery_latitude IS NOT NULL AND d.delivery_longitude IS NOT NULL
                       AND d.delivery_address IS NOT NULL) AS has_destination
               FROM dispatches d
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
              WHERE d.dispatch_id = ANY($1) OR d.route_batch_id = ANY($2)
              ORDER BY d.dispatch_id
                FOR UPDATE OF d`,
            [dispatchIds, batchIds],
        );
        return new Map(rows.map((row) => [row.dispatch_id, row]));
    }

    private async buildFacts(
        manager: EntityManager,
        group: CutoffGroup,
        batchPlan: CutoffBatchPlan,
        batches: Map<number, LockedBatch>,
        dispatches: Map<number, LockedDispatch>,
        context: CutoffWriteContext,
    ): Promise<BatchFacts> {
        const locked = batchPlan.routeBatchId === null ? undefined : batches.get(batchPlan.routeBatchId);
        const stops: StopFacts[] = batchPlan.stops.map((stop) => {
            const read = context.stopsById.get(stop.dispatchId)!;
            const current = dispatches.get(stop.dispatchId);
            return {
                dispatchId: stop.dispatchId,
                sequence: stop.sequence,
                expectedVersion: stop.version,
                currentVersion: current?.version ?? null,
                status: current?.status ?? 'unknown',
                currentRouteBatchId: current?.route_batch_id ?? null,
                hasDestination: current?.has_destination ?? false,
                window: read.window,
                dispatch: read.dispatch,
            };
        });

        const vehicle = batchPlan.vehicleId === null
            ? null
            : context.fleet.find((candidate) => candidate.vehicleId === batchPlan.vehicleId) ?? null;
        const others = group.batchIds;

        let vehicleConflictBatchId: number | null = null;
        if (batchPlan.vehicleId !== null) {
            const [row]: { route_batch_id: number }[] = await manager.query(
                `SELECT route_batch_id FROM route_batches
                  WHERE vehicle_id = $1 AND shift_date = $2::date AND status <> 'cancelled'
                    AND route_batch_id <> ALL($3::int[])
                  LIMIT 1`,
                [batchPlan.vehicleId, batchPlan.shiftDate, others],
            );
            vehicleConflictBatchId = row?.route_batch_id ?? null;
        }

        let driverActive = true;
        let driverConflictBatchId: number | null = null;
        if (batchPlan.proposedDriverId !== null) {
            const [driver]: { user_id: number }[] = await manager.query(
                `SELECT u.user_id FROM users u JOIN roles r ON r.role_id = u.role_id
                  WHERE u.user_id = $1 AND u.active = TRUE AND u.deleted_at IS NULL AND r.name = 'driver'`,
                [batchPlan.proposedDriverId],
            );
            driverActive = driver !== undefined;
            const [row]: { route_batch_id: number }[] = await manager.query(
                `SELECT route_batch_id FROM route_batches
                  WHERE (driver_id = $1 OR proposed_driver_id = $1) AND shift_date = $2::date
                    AND status <> 'cancelled' AND route_batch_id <> ALL($3::int[])
                  LIMIT 1`,
                [batchPlan.proposedDriverId, batchPlan.shiftDate, others],
            );
            driverConflictBatchId = row?.route_batch_id ?? null;
        }

        return {
            routeBatchId: batchPlan.routeBatchId,
            expectedVersion: batchPlan.expectedVersion,
            currentVersion: locked && locked.status === RouteBatchStatusEnum.PROVISIONAL ? locked.version : null,
            allowedBatchIds: group.batchIds,
            vehicleId: batchPlan.vehicleId,
            vehicle,
            vehicleConflictBatchId,
            proposedDriverId: batchPlan.proposedDriverId,
            driverActive,
            driverConflictBatchId,
            stops,
            reoptimizationIncomplete: batchPlan.reoptimizationIncomplete,
        };
    }

    private async cancelBatches(manager: EntityManager, ids: number[]): Promise<void> {
        await manager.query(
            `UPDATE route_batches SET status = $2, version = version + 1, updated_at = NOW()
              WHERE route_batch_id = ANY($1) AND status <> $2`,
            [ids, RouteBatchStatusEnum.CANCELLED],
        );
    }

    private async recordValidationEvent(
        manager: EntityManager,
        routeBatchId: number,
        validation: CutoffValidation,
        context: CutoffWriteContext,
        extra: Record<string, unknown> = {},
    ): Promise<void> {
        const events = manager.getRepository(RouteBatchEvent);
        await events.save(events.create({
            routeBatchId,
            dispatchId: null,
            eventType: validation.passed ? 'cutoff_validated' : 'cutoff_failed',
            actorUserId: null,
            actorType: 'system',
            reason: validation.passed ? null : validation.failures.map((failure) => failure.code).join(','),
            metadata: {
                failures: validation.failures,
                warnings: validation.warnings,
                trigger: context.trigger,
                occurrence: context.occurrence,
                ...extra,
            },
        }));
    }

    private async recordEvents(
        manager: EntityManager,
        group: CutoffGroup,
        context: CutoffWriteContext,
        data: {
            validations: Map<CutoffBatchPlan, CutoffValidation>;
            finalIdOf: Map<string, number>;
            remnantIds: number[];
            /** Batches that were left with nothing (every order released). */
            emptied: number[];
            released: Map<number, number>;
            moves: Array<{ dispatchId: number; to: number; sequence: number; reason: string; from: number | null; version: number }>;
        },
    ): Promise<void> {
        const trace = { trigger: context.trigger, occurrence: context.occurrence };
        const batchEvents = manager.getRepository(RouteBatchEvent);
        const dispatchEvents = manager.getRepository(DispatchEvent);
        const batchRows: RouteBatchEvent[] = [];
        const dispatchRows: DispatchEvent[] = [];
        const newId = (movement: { toBatchId: number | null; toNewRef: string | null }): number | null =>
            movement.toBatchId ?? (movement.toNewRef ? data.finalIdOf.get(movement.toNewRef) ?? null : null);

        for (const movement of group.plan.movements) {
            const to = newId(movement);
            if (to === null) continue;
            const base = { dispatchIds: movement.dispatchIds, fromBatchId: movement.fromBatchId, toBatchId: to, ...trace };
            if (movement.kind === 'merged') {
                batchRows.push(batchEvents.create({
                    routeBatchId: to, dispatchId: null, eventType: 'merged', actorUserId: null, actorType: 'system',
                    reason: 'cutoff_reoptimization', metadata: { ...base, role: 'survivor', absorbedBatchId: movement.fromBatchId },
                }));
                batchRows.push(batchEvents.create({
                    routeBatchId: movement.fromBatchId, dispatchId: null, eventType: 'cancelled', actorUserId: null,
                    actorType: 'system', reason: 'merged_into_batch', metadata: { ...base, role: 'absorbed', intoBatchId: to },
                }));
            } else if (movement.kind === 'split') {
                batchRows.push(batchEvents.create({
                    routeBatchId: movement.fromBatchId, dispatchId: null, eventType: 'split', actorUserId: null,
                    actorType: 'system', reason: 'cutoff_reoptimization', metadata: { ...base, newBatchId: to },
                }));
                batchRows.push(batchEvents.create({
                    routeBatchId: to, dispatchId: null, eventType: 'created', actorUserId: null, actorType: 'system',
                    reason: 'cutoff_split', metadata: { ...base, splitFromBatchId: movement.fromBatchId },
                }));
            } else {
                for (const dispatchId of movement.dispatchIds) {
                    batchRows.push(batchEvents.create({
                        routeBatchId: movement.fromBatchId, dispatchId, eventType: 'order_removed', actorUserId: null,
                        actorType: 'system', reason: 'cutoff_reoptimization', metadata: { ...base, dispatchId },
                    }));
                    batchRows.push(batchEvents.create({
                        routeBatchId: to, dispatchId, eventType: 'order_added', actorUserId: null, actorType: 'system',
                        reason: 'cutoff_reoptimization', metadata: { ...base, dispatchId },
                    }));
                }
            }
        }

        group.plan.remnants.forEach((remnant, index) => {
            const remnantId = data.remnantIds[index];
            const meta = { sourceBatchId: remnant.sourceBatchId, remnantBatchId: remnantId, dispatchIds: remnant.dispatchIds, ...trace };
            batchRows.push(batchEvents.create({
                routeBatchId: remnantId, dispatchId: null, eventType: 'created', actorUserId: null, actorType: 'system',
                reason: 'cutoff_window_open', metadata: meta,
            }));
            for (const dispatchId of remnant.dispatchIds) {
                batchRows.push(batchEvents.create({
                    routeBatchId: remnant.sourceBatchId, dispatchId, eventType: 'order_removed', actorUserId: null,
                    actorType: 'system', reason: 'cutoff_window_open', metadata: { ...meta, dispatchId },
                }));
            }
        });

        for (const [dispatchId, fromBatchId] of data.released) {
            const metadata = { previousRouteBatchId: fromBatchId, ...trace };
            batchRows.push(batchEvents.create({
                routeBatchId: fromBatchId, dispatchId, eventType: 'order_removed', actorUserId: null, actorType: 'system',
                reason: 'cutoff_no_promise', metadata,
            }));
            dispatchRows.push(dispatchEvents.create({
                dispatchId, eventType: 'removed_from_provisional_batch', detail: 'Cutoff: the order had no promise.',
                actorUserId: null, actorType: 'system', reason: 'cutoff_no_promise',
                metadata: { from: DispatchStatusEnum.IN_PLANNING, to: DispatchStatusEnum.PENDING, ...metadata },
            }));
        }

        for (const untouched of group.plan.untouched) {
            batchRows.push(batchEvents.create({
                routeBatchId: untouched.routeBatchId, dispatchId: null, eventType: 'cutoff_skipped', actorUserId: null,
                actorType: 'system', reason: 'cutoff_window_open', metadata: { openDispatchIds: untouched.openDispatchIds, ...trace },
            }));
        }
        for (const batchId of data.emptied) {
            batchRows.push(batchEvents.create({
                routeBatchId: batchId, dispatchId: null, eventType: 'cancelled', actorUserId: null, actorType: 'system',
                reason: 'cutoff_no_promise', metadata: { ...trace },
            }));
        }

        for (const move of data.moves) {
            if (move.reason === 'resequenced') continue;
            dispatchRows.push(dispatchEvents.create({
                dispatchId: move.dispatchId, eventType: 'moved_between_batches',
                detail: 'Cutoff: the order changed batch inside its promise.', actorUserId: null, actorType: 'system',
                reason: move.reason === 'window_open' ? 'cutoff_window_open' : 'cutoff_reoptimization',
                metadata: { fromBatchId: move.from, toBatchId: move.to, sequenceOrder: move.sequence, ...trace },
            }));
        }

        await batchEvents.save(batchRows);
        if (dispatchRows.length > 0) await dispatchEvents.save(dispatchRows);

        // Validation outcome per batch, last so it reads as the closing line of the group.
        for (const [batchPlan, validation] of data.validations) {
            const routeBatchId = batchPlan.routeBatchId ?? data.finalIdOf.get(batchPlan.newRef!)!;
            await this.recordValidationEvent(manager, routeBatchId, validation, context, {
                vehicleId: batchPlan.vehicleId,
                stops: batchPlan.stops.length,
            });
        }
    }
}

function outcome(
    routeBatchId: number,
    batchPlan: CutoffBatchPlan,
    validation: CutoffValidation,
    applied: boolean,
): CutoffBatchOutcome {
    return {
        routeBatchId,
        status: applied && validation.passed ? RouteBatchStatusEnum.PENDING_FINAL_REVIEW : RouteBatchStatusEnum.PROVISIONAL,
        failures: validation.failures,
        warnings: validation.warnings,
        vehicleId: batchPlan.vehicleId,
        stops: batchPlan.stops.length,
    };
}
