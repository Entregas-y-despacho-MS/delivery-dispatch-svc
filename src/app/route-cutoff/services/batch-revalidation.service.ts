import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { SettingsService } from '../../../modules/settings/services/settings.service.js';
import { loadPlanningSettings } from '../../planning/domain/planning-settings.js';
import type { PlanVehicle } from '../../planning/domain/plan-types.js';
import type { SimParams } from '../../planning/domain/route-simulation.js';
import { PlanningSettingsMissingException } from '../../planning/exceptions/index.js';
import { PlanCandidatesRepository } from '../../planning/services/plan-candidates.repository.js';
import { buildSimParams } from '../domain/cutoff-sim-params.js';
import {
    validateCutoffBatch,
    type BatchFacts,
    type CutoffFailureCode,
    type CutoffIssue,
    type CutoffValidation,
    type StopFacts,
} from '../domain/cutoff-validation.js';
import { CutoffBatchesRepository, type SingleBatchRead } from './cutoff-batches.repository.js';
import { findDriverFacts, findVehicleConflict } from './cutoff-facts.queries.js';
import { CutoffMatricesService } from './cutoff-matrices.service.js';

export type UnvalidatableReason = 'no_dispatches' | 'no_warehouse' | 'warehouse_unavailable' | 'stops_incomplete';

/** What is read before the transaction: no lock is held while OSRM answers. */
export interface PreparedRevalidation {
    routeBatchId: number;
    read: SingleBatchRead | null;
    fleet: PlanVehicle[];
    params: SimParams | null;
    /** Why the batch cannot be simulated; the validation then fails with `batch_not_validatable`. */
    unvalidatable: UnvalidatableReason | null;
}

/** The batch as it is under the caller's lock, with the assignment the correction wants to leave in it. */
export interface LockedBatchState {
    version: number;
    vehicleId: number | null;
    proposedDriverId: number | null;
}

export type RevalidationOutcome =
    /** Somebody changed the batch or its orders after they were read: nothing can be concluded, the caller reloads. */
    | { kind: 'stale'; issues: CutoffIssue[] }
    | { kind: 'evaluated'; validation: CutoffValidation };

/** Failures that mean "the facts moved while computing" rather than "the batch is not viable". */
const STALE_CODES: ReadonlySet<CutoffFailureCode> = new Set([
    'batch_version_changed',
    'batch_not_found',
    'dispatch_version_changed',
    'dispatch_not_found',
]);

interface LockedDispatchRow {
    dispatch_id: number;
    status: string;
    version: number;
    route_batch_id: number | null;
    has_destination: boolean;
}

/**
 * Validation of ONE batch with the rules of the D-1 cutoff (ST-51.3), run after a coordinator corrects its
 * driver or vehicle (ST-51.6). It is the same pure `validateCutoffBatch` the cutoff uses, fed with the facts of
 * a single batch, so a corrected batch is judged exactly like one that left the cutoff.
 *
 * Two steps because OSRM must not be called while a row lock is held: `prepare` (no lock, may reach OSRM) and
 * `evaluate` (inside the caller's transaction, after it locked the batch).
 */
@Injectable()
export class BatchRevalidationService {
    constructor(
        private readonly settings: SettingsService,
        private readonly batches: CutoffBatchesRepository,
        private readonly candidates: PlanCandidatesRepository,
        private readonly matrices: CutoffMatricesService,
    ) {}

    async prepare(routeBatchId: number): Promise<PreparedRevalidation> {
        const loaded = await loadPlanningSettings(this.settings);
        if (!loaded.ok) {
            throw new PlanningSettingsMissingException(loaded.missingKeys, loaded.invalidKeys, loaded.configurationProblem);
        }
        const read = await this.batches.findBatch(routeBatchId);
        const base = { routeBatchId, read, fleet: [] as PlanVehicle[], params: null };
        if (read === null) return { ...base, unvalidatable: 'no_dispatches' };
        if (!read.hasWarehouse) return { ...base, unvalidatable: 'no_warehouse' };
        if (read.incompleteDispatchIds.length > 0 || read.batch.stops.length === 0) {
            return { ...base, unvalidatable: 'stops_incomplete' };
        }

        const [fleet, warehouses] = await Promise.all([this.candidates.findVehicles(), this.candidates.findWarehouses()]);
        if (!warehouses.some((warehouse) => warehouse.warehouseId === read.batch.warehouseId)) {
            return { ...base, fleet, unvalidatable: 'warehouse_unavailable' };
        }
        // OSRM down: this throws and the caller has not locked or written anything yet.
        const travelFor = this.matrices.travelFor(await this.matrices.load([read.batch], warehouses));
        const params = buildSimParams(loaded.values!, travelFor(read.batch.warehouseId, read.batch.zoneId));
        return { ...base, fleet, params, unvalidatable: null };
    }

    async evaluate(manager: EntityManager, prepared: PreparedRevalidation, state: LockedBatchState): Promise<RevalidationOutcome> {
        const { read, params } = prepared;
        if (prepared.unvalidatable !== null || read === null || params === null) {
            // Nothing to simulate, but a batch that moved since it was read is still stale, not "not validatable".
            if (read !== null && state.version !== read.batch.version) {
                return { kind: 'stale', issues: [{ code: 'batch_version_changed', dispatchIds: [], detail: { expected: read.batch.version, current: state.version } }] };
            }
            return { kind: 'evaluated', validation: notValidatable(prepared) };
        }
        const batch = read.batch;
        const readIds = batch.stops.map((stop) => stop.dispatch.dispatchId);

        const rows: LockedDispatchRow[] = await manager.query(
            `SELECT d.dispatch_id, s.name AS status, d.version, d.route_batch_id,
                    (d.delivery_latitude IS NOT NULL AND d.delivery_longitude IS NOT NULL
                       AND d.delivery_address IS NOT NULL) AS has_destination
               FROM dispatches d
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
              WHERE d.dispatch_id = ANY($1) OR d.route_batch_id = $2
              ORDER BY d.dispatch_id
                FOR UPDATE OF d`,
            [readIds, batch.routeBatchId],
        );
        const current = new Map(rows.map((row) => [row.dispatch_id, row]));

        const stale: CutoffIssue[] = [];
        if (state.version !== batch.version) {
            stale.push({ code: 'batch_version_changed', dispatchIds: [], detail: { expected: batch.version, current: state.version } });
        }
        const added = rows.filter((row) => row.route_batch_id === batch.routeBatchId && !readIds.includes(row.dispatch_id));
        if (added.length > 0) {
            stale.push({ code: 'dispatch_version_changed', dispatchIds: added.map((row) => row.dispatch_id), detail: { reason: 'added_to_batch' } });
        }
        if (stale.length > 0) return { kind: 'stale', issues: stale };

        const stops: StopFacts[] = batch.stops.map((stop) => {
            const row = current.get(stop.dispatch.dispatchId);
            return {
                dispatchId: stop.dispatch.dispatchId,
                sequence: stop.sequence,
                expectedVersion: stop.version,
                currentVersion: row?.version ?? null,
                status: row?.status ?? 'unknown',
                currentRouteBatchId: row?.route_batch_id ?? null,
                hasDestination: row?.has_destination ?? false,
                window: stop.window,
                dispatch: stop.dispatch,
            };
        });

        const own = [batch.routeBatchId];
        const vehicleConflictBatchId = state.vehicleId === null
            ? null
            : await findVehicleConflict(manager, state.vehicleId, batch.shiftDate, own);
        const driver = state.proposedDriverId === null
            ? { active: true, conflictBatchId: null }
            : await findDriverFacts(manager, state.proposedDriverId, batch.shiftDate, own);

        const facts: BatchFacts = {
            routeBatchId: batch.routeBatchId,
            expectedVersion: batch.version,
            currentVersion: state.version,
            allowedBatchIds: own,
            vehicleId: state.vehicleId,
            vehicle: state.vehicleId === null ? null : prepared.fleet.find((vehicle) => vehicle.vehicleId === state.vehicleId) ?? null,
            vehicleConflictBatchId,
            proposedDriverId: state.proposedDriverId,
            driverActive: driver.active,
            driverConflictBatchId: driver.conflictBatchId,
            stops,
            reoptimizationIncomplete: false,
        };
        const validation = validateCutoffBatch(facts, params);

        const moved = validation.failures.filter((failure) => STALE_CODES.has(failure.code));
        if (moved.length > 0) return { kind: 'stale', issues: moved };
        return { kind: 'evaluated', validation };
    }
}

function notValidatable(prepared: PreparedRevalidation): CutoffValidation {
    return {
        passed: false,
        failures: [{
            code: 'batch_not_validatable',
            dispatchIds: prepared.read?.incompleteDispatchIds ?? [],
            detail: { reason: prepared.unvalidatable },
        }],
        warnings: [],
        capacity: null,
    };
}
