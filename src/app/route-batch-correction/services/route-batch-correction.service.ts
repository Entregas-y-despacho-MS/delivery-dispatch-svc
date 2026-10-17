import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { RouteBatchApprovalConflictException } from '../../../modules/dispatch/route-batches/exceptions/route-batch-approval-conflict.exception.js';
import { RouteBatchNotCorrectableException } from '../../../modules/dispatch/route-batches/exceptions/route-batch-not-correctable.exception.js';
import { RouteBatchNotFoundException } from '../../../modules/dispatch/route-batches/exceptions/route-batch-not-found.exception.js';
import { RouteBatchResourcesService } from '../../../modules/dispatch/route-batches/services/route-batch-resources.service.js';
import { RouteCapacityService } from '../../../modules/dispatch/route-batches/services/route-capacity.service.js';
import type { RouteCapacityReport } from '../../../modules/dispatch/route-batches/domain/route-capacity.js';
import { isUniqueViolation } from '../../../shared/orm/unique-violation.js';
import { RouteBatchStatusEnum } from '../../../shared/enums/index.js';
import type { CutoffValidation } from '../../route-cutoff/domain/cutoff-validation.js';
import { BatchRevalidationService, type PreparedRevalidation } from '../../route-cutoff/services/batch-revalidation.service.js';
import type { RouteBatchCorrectionResultDto } from '../dto/route-batch-correction-result.dto.js';

type Correction = { kind: 'vehicle'; vehicleId: number } | { kind: 'driver'; driverId: number };

interface BatchRow {
    id: number;
    version: number;
    status: string;
    shift_date: string;
    vehicle_id: number | null;
    proposed_driver_id: number | null;
}

const CORRECTABLE: ReadonlySet<string> = new Set([RouteBatchStatusEnum.PROVISIONAL, RouteBatchStatusEnum.PENDING_FINAL_REVIEW]);

/**
 * Correction of the vehicle or the proposed driver of a route batch (ST-51.6). Allowed while the batch is
 * `provisional` or `pending_final_review`, the two states in which a coordinator still reviews it.
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
    ) {}

    async changeVehicle(routeBatchId: number, vehicleId: number, expectedVersion: number, actorUserId: number): Promise<RouteBatchCorrectionResultDto> {
        return await this.correct(routeBatchId, { kind: 'vehicle', vehicleId }, expectedVersion, actorUserId);
    }

    async changeDriver(routeBatchId: number, driverId: number, expectedVersion: number, actorUserId: number): Promise<RouteBatchCorrectionResultDto> {
        return await this.correct(routeBatchId, { kind: 'driver', driverId }, expectedVersion, actorUserId);
    }

    private async correct(routeBatchId: number, correction: Correction, expectedVersion: number, actorUserId: number): Promise<RouteBatchCorrectionResultDto> {
        // Not locked: only to know whether the validation needs OSRM, which must not be called under a lock.
        const [seen]: { status: string }[] = await this.dataSource.query(
            `SELECT status FROM route_batches WHERE route_batch_id = $1`,
            [routeBatchId],
        );
        if (!seen) throw new RouteBatchNotFoundException();
        this.assertCorrectable(seen.status);
        const prepared = seen.status === RouteBatchStatusEnum.PENDING_FINAL_REVIEW
            ? await this.revalidation.prepare(routeBatchId)
            : null;

        try {
            return await this.dataSource.transaction(
                async (manager) => await this.apply(manager, routeBatchId, correction, expectedVersion, actorUserId, seen.status, prepared),
            );
        } catch (error) {
            throw this.mapUniqueConflict(error);
        }
    }

    private async apply(
        manager: EntityManager,
        routeBatchId: number,
        correction: Correction,
        expectedVersion: number,
        actorUserId: number,
        statusSeen: string,
        prepared: PreparedRevalidation | null,
    ): Promise<RouteBatchCorrectionResultDto> {
        const [batch]: BatchRow[] = await manager.query(
            `SELECT route_batch_id AS id, version, status, shift_date::text AS shift_date, vehicle_id, proposed_driver_id
               FROM route_batches WHERE route_batch_id = $1 FOR UPDATE`,
            [routeBatchId],
        );
        if (!batch) throw new RouteBatchNotFoundException();
        // Status first: a confirmed batch is final, and "not correctable" tells the caller more than a stale version.
        this.assertCorrectable(batch.status);
        if (batch.version !== expectedVersion) {
            throw new RouteBatchApprovalConflictException('ROUTE_BATCH_VERSION_CONFLICT', `Route batch ${routeBatchId} changed; expected version ${expectedVersion}, current version ${batch.version}.`);
        }
        if (batch.status !== statusSeen) {
            throw new RouteBatchApprovalConflictException('ROUTE_BATCH_VERSION_CONFLICT', `Route batch ${routeBatchId} changed from ${statusSeen} to ${batch.status} while the correction was prepared. Reload it.`);
        }

        const current = correction.kind === 'vehicle' ? batch.vehicle_id : batch.proposed_driver_id;
        const target = correction.kind === 'vehicle' ? correction.vehicleId : correction.driverId;
        if (current === target) {
            return this.result(batch, batch.version, batch.status, { changed: false, capacity: null, validation: null });
        }
        const next = {
            vehicleId: correction.kind === 'vehicle' ? correction.vehicleId : batch.vehicle_id,
            driverId: correction.kind === 'driver' ? correction.driverId : batch.proposed_driver_id,
        };

        // Same order as the 2nd approval: the batch, then its orders, then the resources.
        let validation: CutoffValidation | null = null;
        if (batch.status === RouteBatchStatusEnum.PENDING_FINAL_REVIEW) {
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
        const updated: { version: number }[] = await manager.query(
            `UPDATE route_batches
                SET vehicle_id = $3, proposed_driver_id = $4, status = $5, version = version + 1, updated_at = NOW()
              WHERE route_batch_id = $1 AND version = $2
              RETURNING version`,
            [routeBatchId, batch.version, next.vehicleId, next.driverId, status],
        );
        if (updated.length === 0) {
            throw new RouteBatchApprovalConflictException('ROUTE_BATCH_VERSION_CONFLICT', `Route batch ${routeBatchId} changed during the correction. Reload it.`);
        }
        const version = updated[0].version;

        await this.recordEvent(manager, routeBatchId, correction.kind === 'vehicle' ? 'vehicle_changed' : 'driver_changed', actorUserId, 'user', null, {
            previous: current,
            current: target,
            previousVersion: batch.version,
            version,
            previousStatus: batch.status,
            status,
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

        return this.result({ ...batch, vehicle_id: next.vehicleId, proposed_driver_id: next.driverId }, version, status, {
            changed: true,
            capacity,
            validation,
        });
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
        return new RouteBatchApprovalConflictException('ROUTE_BATCH_RESOURCE_CONFLICT', 'The selected vehicle was assigned to another route batch for this day. Reload and review the batch.');
    }
}
