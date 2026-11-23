import { Injectable } from '@nestjs/common';
import { todayInOperatingTimeZone } from '../../../modules/dispatch/dispatches/utils/operating-date.util.js';
import { CUTOFF_EXCLUSION_EXPLANATIONS, type CutoffExclusionCode } from '../domain/cutoff-exclusion.js';
import { computeCoverage, pickOfficialCutoff } from '../domain/coverage.js';
import { sumCounts, departedOf, finalizedOf, percentOf, summarizeRoute, type OutcomeCounts, type RouteCompletion } from '../domain/route-completion.js';
import type { CutoffCoverageParamsDto, OperatingDateParamsDto, SnapshotFiltersDto } from '../dto/planning-snapshots-params.dto.js';
import type {
    CutoffCoverageResponseDto,
    CutoffListResponseDto,
    CutoffSummaryDto,
    OutcomeCountsDto,
    RouteCompletionDto,
    RouteCompletionResponseDto,
} from '../dto/planning-snapshots.dto.js';
import { PlanningSnapshotsRepository, type CutoffRow, type SnapshotFilters } from '../repositories/planning-snapshots.repository.js';

const detailPath = (dispatchId: number): string => `/dispatches/${dispatchId}/detail`;

/** Explanation of a code the catalog no longer knows (an old snapshot): the code itself, never an invented sentence. */
const explanationOf = (code: string): string => CUTOFF_EXCLUSION_EXPLANATIONS[code as CutoffExclusionCode] ?? code;

function toCounts(counts: OutcomeCounts): OutcomeCountsDto {
    return {
        delivered: counts.delivered,
        pickupCompleted: counts.pickup_completed,
        unsuccessful: counts.unsuccessful,
        pending: counts.pending,
        excludedAtStart: counts.excluded_at_start,
        cancelledBeforeStart: counts.cancelled_before_start,
        removedBeforeStart: counts.removed_before_start,
    };
}

/**
 * ST-302.2 (ES-302, Dashboard 2) — coverage at the cutoff and completion of the stops of a started route, both over
 * frozen data: the cutoff universe and the route manifests. With no snapshot the answer is "not available", never a
 * rebuild from today's statuses. Read-only.
 */
@Injectable()
export class PlanningSnapshotsService {
    constructor(private readonly repository: PlanningSnapshotsRepository) {}

    async listCutoffs(params: OperatingDateParamsDto): Promise<CutoffListResponseDto> {
        const date = params.date ?? todayInOperatingTimeZone();
        const rows = await this.repository.findCutoffsOfDay(date);
        const official = pickOfficialCutoff(rows);
        return { date, data: rows.map((row) => this.toSummary(row, row.id === official?.id)) };
    }

    async getCoverage(params: CutoffCoverageParamsDto): Promise<CutoffCoverageResponseDto> {
        const date = params.date ?? todayInOperatingTimeZone();
        const filters = this.filtersOf(params);

        if (params.cutoffId !== undefined) {
            const cutoff = await this.repository.findCutoff(params.cutoffId);
            if (cutoff === null) return this.unavailable(date, 'NO_SNAPSHOT');
            // The cutoff decides the day: a different `date` next to it would mix two days.
            const official = pickOfficialCutoff(await this.repository.findCutoffsOfDay(cutoff.shiftDate))?.id === cutoff.id;
            return await this.coverageOf(cutoff.shiftDate, cutoff, official, filters);
        }

        const ofDay = await this.repository.findCutoffsOfDay(date);
        if (ofDay.length === 0) return this.unavailable(date, 'NO_SNAPSHOT');
        const chosen = pickOfficialCutoff(ofDay);
        if (chosen === null) return this.unavailable(date, 'NO_OFFICIAL_SNAPSHOT');
        return await this.coverageOf(date, chosen, true, filters);
    }

    async getRouteCompletion(params: SnapshotFiltersDto): Promise<RouteCompletionResponseDto> {
        const date = params.date ?? todayInOperatingTimeZone();
        const filters = this.filtersOf(params);

        const manifests = await this.repository.findStartedManifests(date, filters);
        const stops = await this.repository.findBaselineStops(manifests.map((manifest) => manifest.routeBatchId), filters.shift);
        const stopsByBatch = new Map<number, typeof stops>();
        for (const stop of stops) stopsByBatch.set(stop.routeBatchId, [...(stopsByBatch.get(stop.routeBatchId) ?? []), stop]);

        const routes: Array<{ dto: RouteCompletionDto; completion: RouteCompletion }> = [];
        for (const manifest of manifests) {
            const completion = summarizeRoute(stopsByBatch.get(manifest.routeBatchId) ?? []);
            // With a shift filter a route with no stop of that shift has nothing to show.
            if (filters.shift !== undefined && completion.stops.length === 0) continue;
            routes.push({
                completion,
                dto: {
                    routeBatchId: manifest.routeBatchId,
                    manifestVersion: manifest.manifestVersion,
                    routeVersion: manifest.routeVersion,
                    startedAt: manifest.startedAt.toISOString(),
                    vehicle: manifest.vehicle,
                    driver: manifest.driver,
                    zone: manifest.zone,
                    warehouse: manifest.warehouse,
                    counts: toCounts(completion.counts),
                    departed: completion.departed,
                    finalized: completion.finalized,
                    finalizedPct: completion.finalizedPct,
                    stops: completion.stops.map((stop) => ({
                        dispatchId: stop.dispatchId,
                        sequenceOrder: stop.sequenceOrder,
                        dispatchType: stop.dispatchType,
                        outcome: stop.outcome,
                        currentStatus: stop.currentStatus,
                        detailPath: detailPath(stop.dispatchId),
                    })),
                },
            });
        }

        // Weighted by stops: the sum of the counts, never the average of the percentages of each route.
        const counts = sumCounts(routes.map((route) => route.completion.counts));
        const departed = departedOf(counts);
        const finalized = finalizedOf(counts);
        const unknown = await this.repository.findRoutesWithoutBaseline(date, filters);

        return {
            date,
            summary: {
                routesWithBaseline: routes.length,
                routesUnknown: unknown.length,
                counts: toCounts(counts),
                departed,
                finalized,
                finalizedPct: percentOf(finalized, departed),
            },
            data: routes.map((route) => route.dto),
            unknownRouteBatchIds: unknown,
        };
    }

    private async coverageOf(date: string, cutoff: CutoffRow, official: boolean, filters: SnapshotFilters): Promise<CutoffCoverageResponseDto> {
        const universe = await this.repository.findUniverse(cutoff.id, filters);
        const result = computeCoverage(universe);
        const outside = await this.repository.countConfirmedOutsideUniverse(cutoff.id);
        return {
            date,
            available: true,
            reason: null,
            cutoff: this.toSummary(cutoff, official),
            coverage: {
                eligible: result.eligible,
                confirmed: result.confirmed,
                pending: result.pending,
                coveragePct: result.coveragePct,
                confirmedOutsideUniverse: outside,
            },
            excluded: {
                total: result.excludedTotal,
                byCode: result.excludedByCode.map(({ code, count }) => ({ code, explanation: explanationOf(code), count })),
                data: universe
                    .filter((row) => row.universeStatus === 'excluded')
                    .map((row) => ({
                        dispatchId: row.dispatchId,
                        code: row.exclusionCode ?? 'unknown',
                        detail: row.exclusionDetail ?? explanationOf(row.exclusionCode ?? 'unknown'),
                        routeBatchId: row.routeBatchId,
                        detailPath: detailPath(row.dispatchId),
                    })),
            },
        };
    }

    private unavailable(date: string, reason: 'NO_SNAPSHOT' | 'NO_OFFICIAL_SNAPSHOT'): CutoffCoverageResponseDto {
        return { date, available: false, reason, cutoff: null, coverage: null, excluded: null };
    }

    private toSummary(row: CutoffRow, official: boolean): CutoffSummaryDto {
        return {
            id: row.id,
            shiftDate: row.shiftDate,
            cutoffAt: row.cutoffAt.toISOString(),
            operatingTimezone: row.operatingTimezone,
            triggerType: row.triggerType,
            occurrence: row.occurrence,
            official,
            eligible: row.eligible,
            excluded: row.excluded,
        };
    }

    private filtersOf(params: SnapshotFiltersDto): SnapshotFilters {
        return { zoneId: params.zoneId, warehouseId: params.warehouseId, shift: params.shift };
    }
}
