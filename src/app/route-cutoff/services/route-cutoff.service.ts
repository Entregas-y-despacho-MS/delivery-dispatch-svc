import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../../../modules/settings/services/settings.service.js';
import { OsrmPort, type Coordinate } from '../../../plugins/osrm/osrm.port.js';
import { PlanningSettingsMissingException } from '../../planning/exceptions/index.js';
import { localDate, nextOperatingDay, previousOperatingDay } from '../../planning/domain/operating-calendar.js';
import { loadPlanningSettings } from '../../planning/domain/planning-settings.js';
import type { PlanVehicle } from '../../planning/domain/plan-types.js';
import { PlanCandidatesRepository } from '../../planning/services/plan-candidates.repository.js';
import { PlanningAlertsService } from '../../planning/services/planning-alerts.service.js';
import type { ScheduledTaskContext } from '../../scheduler/ports/scheduled-task.js';
import { buildSimParams } from '../domain/cutoff-sim-params.js';
import { splitPlanByGroup } from '../domain/cutoff-groups.js';
import { reoptimizeCutoff } from '../domain/cutoff-reoptimization.js';
import type { CutoffBatch, CutoffInput, CutoffStop } from '../domain/cutoff-types.js';
import type { TravelSeconds } from '../../planning/domain/route-simulation.js';
import type { RouteCutoffSummaryDto } from '../dto/route-cutoff-summary.dto.js';
import { CutoffBatchesRepository } from './cutoff-batches.repository.js';
import { RouteCutoffWriterService } from './route-cutoff-writer.service.js';

/**
 * One run of the D-1 cutoff (ST-51.3, D-11): read the provisional batches of the next route day,
 * reoptimize inside the promises, and persist one group (day, zone, warehouse) per transaction.
 *
 * Idempotent by data: it only takes `provisional` batches, so a second run finds nothing new, and
 * a group that changed under it is left as it was for the next run.
 */
@Injectable()
export class RouteCutoffService {
    private readonly logger = new Logger(RouteCutoffService.name);

    constructor(
        private readonly settings: SettingsService,
        private readonly batches: CutoffBatchesRepository,
        private readonly candidates: PlanCandidatesRepository,
        private readonly osrm: OsrmPort,
        private readonly writer: RouteCutoffWriterService,
        private readonly alerts: PlanningAlertsService,
    ) {}

    async run(context: ScheduledTaskContext): Promise<RouteCutoffSummaryDto> {
        const manual = context.trigger === 'manual';

        const loaded = await loadPlanningSettings(this.settings);
        if (!loaded.ok) {
            await this.alerts.raise('settings_missing', {
                missingKeys: loaded.missingKeys,
                invalidKeys: loaded.invalidKeys,
                configurationProblem: loaded.configurationProblem,
            });
            if (manual) {
                throw new PlanningSettingsMissingException(loaded.missingKeys, loaded.invalidKeys, loaded.configurationProblem);
            }
            return emptySummary('blocked', null, loaded.missingKeys);
        }
        const settings = loaded.values!;

        const now = context.startedAt;
        const today = localDate(now);
        // The cutoff of a route day is the previous operating day at `route_cutoff_time`: the clock ticks
        // every day, so a run on a weekend or holiday must not close Monday early. A manual run (a demo)
        // always works on the next operating day.
        const shiftDate = nextOperatingDay(today, settings.calendar);
        if (!manual && previousOperatingDay(shiftDate, settings.calendar) !== today) {
            return emptySummary('not_cutoff_day', null, []);
        }

        const read = await this.batches.findProvisionalBatches(shiftDate);
        const summary = emptySummary('executed', shiftDate, []);
        summary.skippedBatchIds = read.skippedBatchIds;
        for (const batchId of read.skippedBatchIds) {
            await this.alerts.raise('cutoff_batch_skipped', { routeBatchId: batchId, shiftDate });
        }
        if (read.batches.length === 0) {
            return { ...summary, status: 'nothing_to_process' };
        }

        const processed = read.batches.map((batch) => batch.routeBatchId);
        const [fleet, warehouses, occupiedVehicleIds] = await Promise.all([
            this.candidates.findVehicles(),
            this.candidates.findWarehouses(),
            this.batches.findOccupiedVehicleIds(shiftDate, [...processed, ...read.skippedBatchIds]),
        ]);

        // Every matrix is asked for before anything is written: if OSRM is down, nothing changed.
        const matrices = await this.loadMatrices(read.batches, warehouses);
        const travelFor: CutoffInput['travelFor'] = (warehouseId, zoneId) => {
            const matrix = matrices.get(`${warehouseId}|${zoneId}`);
            if (!matrix) throw new Error(`No time matrix for warehouse ${warehouseId} and zone ${zoneId}.`);
            return matrix;
        };

        const plan = reoptimizeCutoff({
            now,
            settings,
            batches: read.batches,
            fleet,
            occupiedVehicleIds,
            maxStopsPerBatch: Math.max(1, this.osrm.tableMaxCoordinates - 1),
            travelFor,
        });

        const stopsById = new Map<number, CutoffStop>();
        for (const batch of read.batches) for (const stop of batch.stops) stopsById.set(stop.dispatch.dispatchId, stop);

        let failedGroups = 0;
        for (const group of splitPlanByGroup(plan, read.batches)) {
            const params = buildSimParams(settings, travelFor(group.warehouseId, group.zoneId));
            const zone = read.batches.find((batch) => batch.zoneId === group.zoneId)!;
            const zoneDetail = { zoneId: zone.zoneId, zoneCode: zone.zoneCode, zoneName: zone.zoneName };
            try {
                const written = await this.applyWithRetry(group, {
                    trigger: manual ? 'manual' : 'scheduled',
                    occurrence: context.occurrence,
                    fleet: fleet as PlanVehicle[],
                    params,
                    stopsById,
                });

                if (written.status === 'stale') {
                    summary.staleGroups += 1;
                    await this.alerts.raise('cutoff_group_stale', { ...zoneDetail, shiftDate, reasons: written.staleReasons.map((r) => r.code) });
                    continue;
                }
                for (const batch of written.batches) {
                    if (batch.failures.length === 0) {
                        summary.pendingFinalReviewBatchIds.push(batch.routeBatchId);
                    } else {
                        const reasons = batch.failures.map((failure) => failure.code);
                        summary.failedBatches.push({ routeBatchId: batch.routeBatchId, reasons });
                        await this.alerts.raise('cutoff_batch_failed', { ...zoneDetail, shiftDate, routeBatchId: batch.routeBatchId, reasons });
                    }
                }
                summary.createdBatchIds.push(...written.createdBatchIds);
                summary.cancelledBatchIds.push(...written.cancelledBatchIds);
                summary.releasedDispatchIds.push(...written.releasedDispatchIds);
                summary.remnantBatchIds.push(...written.remnantBatchIds);
                if (written.remnantDispatchIds.length > 0) {
                    await this.alerts.raise('cutoff_window_open', {
                        ...zoneDetail,
                        shiftDate,
                        remnantBatchIds: written.remnantBatchIds,
                        dispatchIds: written.remnantDispatchIds,
                    });
                }
            } catch (error) {
                // One group failing (a lock timeout...) must not lose the others; its batches stay provisional.
                failedGroups += 1;
                this.logger.error(`Cutoff of group ${group.key} failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        this.logger.log(
            `Route cutoff (${manual ? 'manual' : 'scheduled'}) for ${shiftDate}: ` +
            `${summary.pendingFinalReviewBatchIds.length} to review, ${summary.failedBatches.length} failed validation, ` +
            `${summary.remnantBatchIds.length} remnants, ${summary.releasedDispatchIds.length} released, ` +
            `${summary.staleGroups} stale groups.`,
        );
        // Throwing records a failed run; re-running is safe because the cutoff only takes provisional batches.
        if (failedGroups > 0) throw new Error(`Route cutoff: ${failedGroups} group(s) could not be written`);
        return summary;
    }

    /**
     * One group in one transaction, retried when Postgres picks it as the victim of a deadlock. The cutoff
     * locks the batch and then its orders, while the handling of a shipment change (ST-72.5) locks the order
     * and then raises the version of its batch: the two can wait on each other. The aborted transaction
     * leaves nothing behind, so trying again is safe.
     */
    private async applyWithRetry(
        group: Parameters<RouteCutoffWriterService['applyGroup']>[0],
        context: Parameters<RouteCutoffWriterService['applyGroup']>[1],
    ): ReturnType<RouteCutoffWriterService['applyGroup']> {
        for (let attempt = 1; ; attempt++) {
            try {
                return await this.writer.applyGroup(group, context);
            } catch (error) {
                if (!isDeadlock(error) || attempt >= MAX_GROUP_ATTEMPTS) throw error;
                this.logger.warn(`Cutoff of group ${group.key} was a deadlock victim; attempt ${attempt + 1} of ${MAX_GROUP_ATTEMPTS}.`);
            }
        }
    }

    private async loadMatrices(
        batches: CutoffBatch[],
        warehouses: Array<{ warehouseId: number; latitude: number; longitude: number }>,
    ): Promise<Map<string, TravelSeconds>> {
        const depots = new Map(warehouses.map((warehouse) => [warehouse.warehouseId, warehouse]));
        const members = new Map<string, Map<number, Coordinate>>();
        const depotOf = new Map<string, number>();
        for (const batch of batches) {
            const key = `${batch.warehouseId}|${batch.zoneId}`;
            depotOf.set(key, batch.warehouseId);
            if (!members.has(key)) members.set(key, new Map());
            for (const stop of batch.stops) {
                members.get(key)!.set(stop.dispatch.dispatchId, { lat: stop.dispatch.latitude, lon: stop.dispatch.longitude });
            }
        }

        const matrices = new Map<string, TravelSeconds>();
        for (const [key, stops] of members) {
            const depot = depots.get(depotOf.get(key)!);
            if (!depot) throw new Error(`Warehouse ${depotOf.get(key)} is not available for planning.`);
            const ids = [...stops.keys()];
            const { durations } = await this.osrm.getDurationMatrix([
                { lat: depot.latitude, lon: depot.longitude },
                ...ids.map((id) => stops.get(id)!),
            ]);
            const indexOf = new Map(ids.map((id, i) => [id, i + 1]));
            matrices.set(key, (from, to) => durations[from === null ? 0 : indexOf.get(from)!][indexOf.get(to)!]);
        }
        return matrices;
    }
}

/** Attempts per group when it is chosen as a deadlock victim (`40P01`). */
const MAX_GROUP_ATTEMPTS = 3;

function isDeadlock(error: unknown): boolean {
    const candidate = error as { code?: string; driverError?: { code?: string } } | null;
    return (candidate?.driverError?.code ?? candidate?.code) === '40P01';
}

function emptySummary(
    status: RouteCutoffSummaryDto['status'],
    shiftDate: string | null,
    missingKeys: string[],
): RouteCutoffSummaryDto {
    return {
        status,
        shiftDate,
        pendingFinalReviewBatchIds: [],
        failedBatches: [],
        createdBatchIds: [],
        remnantBatchIds: [],
        cancelledBatchIds: [],
        releasedDispatchIds: [],
        skippedBatchIds: [],
        staleGroups: 0,
        missingKeys,
    };
}
