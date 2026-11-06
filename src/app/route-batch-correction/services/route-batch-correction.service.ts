import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { RouteBatchApprovalConflictException } from '../../../modules/dispatch/route-batches/exceptions/route-batch-approval-conflict.exception.js';
import { RouteBatchNotCorrectableException } from '../../../modules/dispatch/route-batches/exceptions/route-batch-not-correctable.exception.js';
import { RouteBatchNotFoundException } from '../../../modules/dispatch/route-batches/exceptions/route-batch-not-found.exception.js';
import { RouteBatchResourcesService } from '../../../modules/dispatch/route-batches/services/route-batch-resources.service.js';
import { RouteCapacityService } from '../../../modules/dispatch/route-batches/services/route-capacity.service.js';
import type { RouteCapacityReport } from '../../../modules/dispatch/route-batches/domain/route-capacity.js';
import { ROUTE_VEHICLE_CHANGED_EVENT, type RouteVehicleChangedEvent } from '../../../modules/dispatch/route-batches/events/route-vehicle-changed.event.js';
import { isUniqueViolation } from '../../../shared/orm/unique-violation.js';
import { RouteBatchStatusEnum } from '../../../shared/enums/index.js';
import type { CutoffValidation } from '../../route-cutoff/domain/cutoff-validation.js';
import { BatchRevalidationService, type PreparedRevalidation } from '../../route-cutoff/services/batch-revalidation.service.js';
import type { RouteBatchCorrectionResultDto } from '../dto/route-batch-correction-result.dto.js';
import { RouteBatchVehicleChangeReasonRequiredException } from '../exceptions/route-batch-vehicle-change-reason-required.exception.js';

type Correction = { kind: 'vehicle'; vehicleId: number; reason?: string } | { kind: 'driver'; driverId: number };

interface BatchRow {
    id: number;
    version: number;
    status: string;
    shift_date: string;
    vehicle_id: number | null;
    proposed_driver_id: number | null;
    driver_id: number | null;
    accepted_at: Date | string | null;
    zone_name: string | null;
}

interface CorrectionOutcome {
    result: RouteBatchCorrectionResultDto;
    vehicleChangedEvent?: RouteVehicleChangedEvent;
}

function isDeadlock(error: unknown): boolean {
    const candidate = error as { code?: string; driverError?: { code?: string } } | null;
    return (candidate?.driverError?.code ?? candidate?.code) === '40P01';
}

const CORRECTABLE: ReadonlySet<string> = new Set([RouteBatchStatusEnum.PROVISIONAL, RouteBatchStatusEnum.PENDING_FINAL_REVIEW]);

/**
 * Correction of the vehicle or the proposed driver of a route batch (ST-51.6). Driver changes are allowed while
 * the batch is `provisional` or `pending_final_review`. A vehicle-only exception also allows `confirmed` before
 * execution so fleet can recover a committed route from a vehicle fault without changing its driver or stops.
 *
 * The batch is locked, its `version` compared with the one the caller reviewed (D-09) and the new value checked
 * with the rules of the 2nd approval (ST-51.2) and the capacity rule (ST-50.1). In `pending_final_review` the
 * batch is then validated again with the rules of the D-1 cutoff (ST-51.3): if it passes it stays in review, if
 * not it goes back to `provisional` with the reasons in its event log (§3.2 of the planning decisions). The
 * correction is kept either way: the coordinator fixed one thing and the validation says what is still wrong.
 *
 * OSRM is asked BEFORE the transaction, so no row lock is held while it answers; if the batch changed
 * meanwhile the answer is 409 and the caller reloads, never a silent demotion.
 */
@Injectable()
export class RouteBatchCorrectionService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly capacity: RouteCapacityService,
        private readonly resources: RouteBatchResourcesService,
        private readonly revalidation: BatchRevalidationService,
        private readonly events: EventEmitter2,
    ) {}

    async changeVehicle(routeBatchId: number, vehicleId: number, expectedVersion: number, actorUserId: number, reason?: string): Promise<RouteBatchCorrectionResultDto> {
        return await this.correct(routeBatchId, { kind: 'vehicle', vehicleId, reason: reason?.trim() || undefined }, expectedVersion, actorUserId);
    }

    async changeDriver(routeBatchId: number, driverId: number, expectedVersion: number, actorUserId: number): Promise<RouteBatchCorrectionResultDto> {
        return await this.correct(routeBatchId, { kind: 'driver', driverId }, expectedVersion, actorUserId);
    }

    private async correct(routeBatchId: number, correction: Correction, expectedVersion: number, actorUserId: number): Promise<RouteBatchCorrectionResultDto> {
        // Not locked: only to know whether the validation needs OSRM, which must not be called under a lock.
        const [seen]: { status: string; vehicle_id: number | null; proposed_driver_id: number | null }[] = await this.dataSource.query(
            `SELECT status, vehicle_id, proposed_driver_id FROM route_batches WHERE route_batch_id = $1`,
            [routeBatchId],
        );
        if (!seen) throw new RouteBatchNotFoundException();
        if (correction.kind === 'vehicle') this.assertVehicleChangeable(seen.status);
        else this.assertCorrectable(seen.status);
        // Sending what the batch already has changes nothing, so it must not need OSRM (or fail because it is down).
        const unchanged = (correction.kind === 'vehicle' ? seen.vehicle_id : seen.proposed_driver_id)
            === (correction.kind === 'vehicle' ? correction.vehicleId : correction.driverId);
        const prepared = seen.status === RouteBatchStatusEnum.PENDING_FINAL_REVIEW && !unchanged
            ? await this.revalidation.prepare(routeBatchId)
            : null;

        try {
            const outcome = await this.dataSource.transaction(
                async (manager) => await this.apply(manager, routeBatchId, correction, expectedVersion, actorUserId, prepared),
            );
            if (outcome.vehicleChangedEvent) {
                this.events.emit(ROUTE_VEHICLE_CHANGED_EVENT, outcome.vehicleChangedEvent);
            }
            return outcome.result;
        } catch (error) {
            if (isDeadlock(error)) {
                // Two corrections (or a correction and an approval) swapping the same driver or vehicle wait on each
                // other's rows. Postgres aborted this one and nothing was written: reloading and sending it again is safe.
                throw new RouteBatchApprovalConflictException(
                    'ROUTE_BATCH_VERSION_CONFLICT',
                    `Route batch ${routeBatchId} was being changed at the same time by another request. Nothing was changed; reload it and try again.`,
                );
            }
            throw this.mapUniqueConflict(error);
        }
    }

    private async apply(
        manager: EntityManager,
        routeBatchId: number,
        correction: Correction,
        expectedVersion: number,
        actorUserId: number,
        prepared: PreparedRevalidation | null,
    ): Promise<CorrectionOutcome> {
        const [batch]: BatchRow[] = await manager.query(
            `SELECT b.route_batch_id AS id, b.version, b.status, b.shift_date::text AS shift_date,
                    b.vehicle_id, b.proposed_driver_id, b.driver_id, b.accepted_at, z.name AS zone_name
               FROM route_batches b LEFT JOIN delivery_zones z ON z.delivery_zone_id = b.delivery_zone_id
              WHERE b.route_batch_id = $1 FOR UPDATE OF b`,
            [routeBatchId],
        );
        if (!batch) throw new RouteBatchNotFoundException();
        if (correction.kind === 'vehicle') this.assertVehicleChangeable(batch.status);
        else this.assertCorrectable(batch.status);
        if (batch.version !== expectedVersion) {
            throw new RouteBatchApprovalConflictException('ROUTE_BATCH_VERSION_CONFLICT', `Route batch ${routeBatchId} changed; expected version ${expectedVersion}, current version ${batch.version}.`);
        }

        const current = correction.kind === 'vehicle' ? batch.vehicle_id : batch.proposed_driver_id;
        const target = correction.kind === 'vehicle' ? correction.vehicleId : correction.driverId;
        if (current === target) {
            return { result: this.result(batch, batch.version, batch.status, { changed: false, capacity: null, validation: null }) };
        }
        if (correction.kind === 'vehicle' && batch.status === RouteBatchStatusEnum.CONFIRMED && !correction.reason) {
            throw new RouteBatchVehicleChangeReasonRequiredException();
        }
        const next = {
            vehicleId: correction.kind === 'vehicle' ? correction.vehicleId : batch.vehicle_id,
            driverId: correction.kind === 'driver' ? correction.driverId : batch.proposed_driver_id,
        };

        // Same order as the 2nd approval: the batch, then its orders, then the resources.
        let validation: CutoffValidation | null = null;
        if (batch.status === RouteBatchStatusEnum.PENDING_FINAL_REVIEW) {
            // Seen as provisional (or as a no-op) and pending review now: it changed while the correction was prepared.
            if (prepared === null) {
                throw new RouteBatchApprovalConflictException('ROUTE_BATCH_VERSION_CONFLICT', `Route batch ${routeBatchId} changed while the correction was prepared. Reload it.`);
            }
            const outcome = await this.revalidation.evaluate(manager, prepared, {
                version: batch.version,
                vehicleId: next.vehicleId,
                proposedDriverId: next.driverId,
            });
            if (outcome.kind === 'stale') {
                throw new RouteBatchApprovalConflictException(
                    'ROUTE_BATCH_VERSION_CONFLICT',
                    `Route batch ${routeBatchId} or its orders changed while the correction was validated (${outcome.issues.map((issue) => issue.code).join(', ')}). Reload it.`,
                );
            }
            validation = outcome.validation;
        }

        let capacity: RouteCapacityReport | null = null;
        if (correction.kind === 'vehicle') {
            capacity = await this.capacity.assertAssignable(routeBatchId, correction.vehicleId, manager);
            await this.resources.assertVehicleActive(manager, correction.vehicleId);
            await this.resources.assertResourcesAvailable(manager, null, correction.vehicleId, batch.shift_date, routeBatchId);
        } else {
            await this.resources.assertDriverAvailable(manager, correction.driverId, batch.shift_date, routeBatchId);
        }

        const status = validation !== null && !validation.passed ? RouteBatchStatusEnum.PROVISIONAL : batch.status;
        const acceptanceRevoked = correction.kind === 'vehicle'
            && batch.status === RouteBatchStatusEnum.CONFIRMED
            && batch.accepted_at !== null;
        // TypeORM answers an UPDATE ... RETURNING with `[rows, affectedCount]`, not with the rows.
        const [updated]: [{ version: number }[], number] = await manager.query(
            `UPDATE route_batches
                SET vehicle_id = $3, proposed_driver_id = $4, status = $5,
                    accepted_at = CASE WHEN $6::boolean THEN NULL ELSE accepted_at END,
                    version = version + 1, updated_at = NOW()
              WHERE route_batch_id = $1 AND version = $2
              RETURNING version`,
            [routeBatchId, batch.version, next.vehicleId, next.driverId, status, acceptanceRevoked],
        );
        if (updated.length === 0) {
            throw new RouteBatchApprovalConflictException('ROUTE_BATCH_VERSION_CONFLICT', `Route batch ${routeBatchId} changed during the correction. Reload it.`);
        }
        const version = updated[0].version;

        let vehicleChangedEvent: RouteVehicleChangedEvent | undefined;
        if (correction.kind === 'vehicle' && batch.status === RouteBatchStatusEnum.CONFIRMED) {
            const [vehicle]: { plate: string }[] = await manager.query(
                `SELECT plate FROM vehicles WHERE vehicle_id = $1 AND deleted_at IS NULL`,
                [correction.vehicleId],
            );
            // A driver's pull detects this as a route change through lastModifiedAt even if it had not accepted yet.
            await manager.query(
                `UPDATE dispatches SET updated_at = NOW(), version = version + 1
                  WHERE route_batch_id = $1`,
                [routeBatchId],
            );
            vehicleChangedEvent = {
                routeId: routeBatchId,
                driverId: batch.driver_id,
                vehicleId: correction.vehicleId,
                vehiclePlate: vehicle?.plate ?? String(correction.vehicleId),
                zoneName: batch.zone_name,
                version,
                acceptanceRevoked,
            };
        }

        await this.recordEvent(manager, routeBatchId, correction.kind === 'vehicle' ? 'vehicle_changed' : 'driver_changed', actorUserId, 'user', correction.kind === 'vehicle' ? correction.reason ?? null : null, {
            previous: current,
            current: target,
            ...(correction.kind === 'vehicle' && correction.reason ? { reason: correction.reason } : {}),
            previousVersion: batch.version,
            version,
            previousStatus: batch.status,
            status,
            ...(acceptanceRevoked ? { acceptanceRevoked: true } : {}),
        });
        if (validation !== null) {
            await this.recordEvent(
                manager,
                routeBatchId,
                validation.passed ? 'cutoff_validated' : 'cutoff_failed',
                null,
                'system',
                validation.passed ? null : validation.failures.map((failure) => failure.code).join(','),
                {
                    failures: validation.failures,
                    warnings: validation.warnings,
                    trigger: 'correction',
                    occurrence: null,
                    correction: correction.kind,
                    correctedByUserId: actorUserId,
                    previousStatus: batch.status,
                    status,
                },
            );
        }

        return {
            result: this.result({ ...batch, vehicle_id: next.vehicleId, proposed_driver_id: next.driverId }, version, status, {
                changed: true,
                capacity,
                validation,
            }),
            ...(vehicleChangedEvent ? { vehicleChangedEvent } : {}),
        };
    }

    private result(
        batch: BatchRow,
        version: number,
        status: string,
        extra: { changed: boolean; capacity: RouteCapacityReport | null; validation: CutoffValidation | null },
    ): RouteBatchCorrectionResultDto {
        return {
            routeBatchId: batch.id,
            version,
            status: status as RouteBatchCorrectionResultDto['status'],
            vehicleId: batch.vehicle_id,
            proposedDriverId: batch.proposed_driver_id,
            changed: extra.changed,
            capacity: extra.capacity as RouteBatchCorrectionResultDto['capacity'],
            validation: extra.validation === null
                ? null
                : {
                    passed: extra.validation.passed,
                    failures: extra.validation.failures as unknown as Array<Record<string, unknown>>,
                    warnings: extra.validation.warnings as unknown as Array<Record<string, unknown>>,
                },
        };
    }

    private assertCorrectable(status: string): void {
        if (!CORRECTABLE.has(status)) throw new RouteBatchNotCorrectableException(status);
    }

    private assertVehicleChangeable(status: string): void {
        if (status === RouteBatchStatusEnum.CONFIRMED) return;
        this.assertCorrectable(status);
    }

    private async recordEvent(
        manager: EntityManager,
        routeBatchId: number,
        eventType: string,
        actorUserId: number | null,
        actorType: 'user' | 'system',
        reason: string | null,
        metadata: Record<string, unknown>,
    ): Promise<void> {
        await manager.query(
            `INSERT INTO route_batch_events (route_batch_id, event_type, actor_user_id, actor_type, reason, metadata)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [routeBatchId, eventType, actorUserId, actorType, reason, JSON.stringify(metadata)],
        );
    }

    private mapUniqueConflict(error: unknown): unknown {
        if (!isUniqueViolation(error)) return error;
        const constraint = (error as { driverError?: { constraint?: string } }).driverError?.constraint;
        if (constraint === 'uq_route_batches_driver_shift_date') {
            return new RouteBatchApprovalConflictException('ROUTE_BATCH_DRIVER_NOT_AVAILABLE', 'The selected driver was assigned to another route batch for this day. Reload and review the batch.');
        }
        if (constraint === 'uq_route_batches_vehicle_shift_date') {
            return new RouteBatchApprovalConflictException('ROUTE_BATCH_RESOURCE_CONFLICT', 'The selected vehicle was assigned to another route batch for this day. Reload and review the batch.');
        }
        // Any other unique index is not a resource conflict: do not blame the vehicle, let it surface as it is.
        return error;
    }
}
