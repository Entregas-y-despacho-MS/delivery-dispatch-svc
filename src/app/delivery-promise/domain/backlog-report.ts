import { OPERATING_TIME_ZONE } from '../../../modules/dispatch/dispatches/utils/operating-date.util.js';
import type { DeliveryBacklogDto, OpenOverdueDispatchDto, PendingStageDto } from '../dto/delivery-backlog.dto.js';
import { ACTIVE_DISPATCH_STATUSES, AgeRange, BacklogBucket, bucketOf, nextActionOf } from './backlog-buckets.js';
import { FirstAttemptResult, type DispatchAttemptSummary } from './first-attempt.js';
import { appliedFilters } from './otd-metrics.js';

/** One group of dispatches as PostgreSQL returns it: how many are in this status, overdue or not, and how long in the stage. */
export interface BacklogRow {
    status: string;
    overdue: boolean;
    /** Only the active dispatches have an age in their stage. */
    ageRange: AgeRange | null;
    count: number;
}

/** One open overdue dispatch, as the list query returns it. */
export interface OpenOverdueRow {
    dispatchId: number;
    trackingCode: string | null;
    status: string;
    zoneId: number | null;
    serviceLevelId: number | null;
    promiseEnd: Date;
    overdueMinutes: number;
}

const emptyAge = (): Record<AgeRange, number> => ({ [AgeRange.UNDER_1_DAY]: 0, [AgeRange.ONE_TO_3_DAYS]: 0, [AgeRange.OVER_3_DAYS]: 0 });

/**
 * The operational summary of ST-301.1 from the grouped counts. Each row is one status and goes to exactly one bucket, so
 * the counts never overlap; the terminal buckets and the rescheduled ones are never added to `backlogTotal`.
 */
export function buildBacklogReport(
    query: { from: string; to: string; zoneId?: number; serviceLevelId?: number; status?: string },
    rows: readonly BacklogRow[],
    overdueList: readonly OpenOverdueRow[],
    dateBasis: string,
    now: Date,
    attempts: ReadonlyMap<number, DispatchAttemptSummary> = new Map(),
): DeliveryBacklogDto {
    const counts: Record<BacklogBucket, number> = {
        [BacklogBucket.DELIVERED]: 0,
        [BacklogBucket.OPEN_OVERDUE]: 0,
        [BacklogBucket.PENDING]: 0,
        [BacklogBucket.NOT_DELIVERED]: 0,
        [BacklogBucket.RESCHEDULED]: 0,
        [BacklogBucket.CANCELLED]: 0,
        [BacklogBucket.RETURNED]: 0,
    };
    const openOverdueByAge = emptyAge();
    const stages = new Map<string, { total: number; byAge: Record<AgeRange, number> }>();
    let all = 0;

    for (const row of rows) {
        const bucket = bucketOf(row.status, row.overdue);
        counts[bucket] += row.count;
        all += row.count;
        if (bucket === BacklogBucket.OPEN_OVERDUE && row.ageRange) openOverdueByAge[row.ageRange] += row.count;
        if (bucket === BacklogBucket.PENDING) {
            const stage = stages.get(row.status) ?? { total: 0, byAge: emptyAge() };
            stage.total += row.count;
            if (row.ageRange) stage.byAge[row.ageRange] += row.count;
            stages.set(row.status, stage);
        }
    }

    // Stages in the order a dispatch crosses them, and only the ones that have dispatches.
    const pendingByStage: PendingStageDto[] = ACTIVE_DISPATCH_STATUSES.filter((status) => stages.has(status)).map((status) => ({
        stage: status,
        total: stages.get(status)!.total,
        byAge: stages.get(status)!.byAge,
    }));

    const openOverdue: OpenOverdueDispatchDto[] = overdueList.map((row) => ({
        dispatchId: row.dispatchId,
        trackingCode: row.trackingCode,
        status: row.status,
        zoneId: row.zoneId,
        serviceLevelId: row.serviceLevelId,
        promiseEnd: row.promiseEnd.toISOString(),
        overdueMinutes: Math.max(0, row.overdueMinutes),
        nextAction: nextActionOf(row.status),
        // No summary means no event of an attempt was read for it: it has had no attempt yet. A null stays null (cannot be rebuilt).
        ...(attempts.get(row.dispatchId) ?? { attemptsUsed: 0, firstAttemptResult: FirstAttemptResult.NO_ATTEMPT_YET }),
    }));

    return {
        from: query.from,
        to: query.to,
        dateBasis,
        timeZone: OPERATING_TIME_ZONE,
        asOf: now.toISOString(),
        filters: appliedFilters(query),
        counts: {
            delivered: counts[BacklogBucket.DELIVERED],
            openOverdue: counts[BacklogBucket.OPEN_OVERDUE],
            pending: counts[BacklogBucket.PENDING],
            notDelivered: counts[BacklogBucket.NOT_DELIVERED],
            rescheduled: counts[BacklogBucket.RESCHEDULED],
            cancelled: counts[BacklogBucket.CANCELLED],
            returned: counts[BacklogBucket.RETURNED],
        },
        backlogTotal: counts[BacklogBucket.OPEN_OVERDUE] + counts[BacklogBucket.PENDING],
        pendingByStage,
        openOverdueByAge,
        openOverdue,
        empty: all === 0,
    };
}
