import type { SlaMetricsDto, SlaReportDto, SlaReportRowDto } from '../dto/sla-report.dto.js';
import type { SlaGroupBy } from './sla-group-by.js';

/**
 * What PostgreSQL returns for one group: counts and sums, never averages. Averages and the totals are built
 * here, so the totals are the real figures of all the dispatches and not an average of averages.
 */
export interface SlaGroupSums {
    groupId: number | null;
    groupName: string | null;
    closedCount: number;
    deliveredCount: number;
    onTimeCount: number;
    /** Delivered after the end of the window: the only ones that have a delay. */
    lateCount: number;
    delayMinutesSum: number;
    /** Delivered dispatches with a usable departure: the only ones that have a cycle. */
    cycleCount: number;
    cycleMinutesSum: number;
    incidentCount: number;
}

export function round1(value: number): number {
    return Math.round(value * 10) / 10;
}

/** The figures of one group (or of all of them) from its sums. */
export function toMetrics(sums: Omit<SlaGroupSums, 'groupId' | 'groupName'>): SlaMetricsDto {
    return {
        closedCount: sums.closedCount,
        deliveredCount: sums.deliveredCount,
        onTimeCount: sums.onTimeCount,
        lateCount: sums.lateCount,
        onTimePercentage: sums.deliveredCount === 0 ? 0 : round1((sums.onTimeCount / sums.deliveredCount) * 100),
        averageDelayMinutes: sums.lateCount === 0 ? null : round1(sums.delayMinutesSum / sums.lateCount),
        averageCycleMinutes: sums.cycleCount === 0 ? null : round1(sums.cycleMinutesSum / sums.cycleCount),
        incidentCount: sums.incidentCount,
    };
}

function sumGroups(groups: readonly SlaGroupSums[]): Omit<SlaGroupSums, 'groupId' | 'groupName'> {
    const total = { closedCount: 0, deliveredCount: 0, onTimeCount: 0, lateCount: 0, delayMinutesSum: 0, cycleCount: 0, cycleMinutesSum: 0, incidentCount: 0 };
    for (const group of groups) {
        total.closedCount += group.closedCount;
        total.deliveredCount += group.deliveredCount;
        total.onTimeCount += group.onTimeCount;
        total.lateCount += group.lateCount;
        total.delayMinutesSum += group.delayMinutesSum;
        total.cycleCount += group.cycleCount;
        total.cycleMinutesSum += group.cycleMinutesSum;
        total.incidentCount += group.incidentCount;
    }
    return total;
}

/** By name, ignoring case and accents; the group without a name goes last; the id breaks ties so the order is always the same. */
function compareRows(a: SlaReportRowDto, b: SlaReportRowDto): number {
    if (a.groupName === null || b.groupName === null) {
        if (a.groupName === b.groupName) return 0;
        return a.groupName === null ? 1 : -1;
    }
    const byName = a.groupName.localeCompare(b.groupName, 'es', { sensitivity: 'base' });
    if (byName !== 0) return byName;
    return (a.groupId ?? 0) - (b.groupId ?? 0);
}

export function buildSlaReport(from: string, to: string, groupBy: SlaGroupBy, groups: readonly SlaGroupSums[]): SlaReportDto {
    const rows = groups
        .map((group): SlaReportRowDto => ({ groupId: group.groupId, groupName: group.groupName, ...toMetrics(group) }))
        .sort(compareRows);
    return { from, to, groupBy, totals: toMetrics(sumGroups(groups)), rows };
}

function isCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNullableAverage(value: unknown): boolean {
    return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function isMetrics(value: unknown): value is SlaMetricsDto {
    if (typeof value !== 'object' || value === null) return false;
    const m = value as Record<string, unknown>;
    return isCount(m.closedCount) && isCount(m.deliveredCount) && isCount(m.onTimeCount) && isCount(m.lateCount) && isCount(m.incidentCount)
        && m.deliveredCount <= m.closedCount
        && m.onTimeCount + m.lateCount <= m.deliveredCount
        && typeof m.onTimePercentage === 'number' && m.onTimePercentage >= 0 && m.onTimePercentage <= 100
        && isNullableAverage(m.averageDelayMinutes) && isNullableAverage(m.averageCycleMinutes)
        // The delay exists exactly when something was late.
        && (m.averageDelayMinutes === null) === (m.lateCount === 0);
}

function isRow(value: unknown): value is SlaReportRowDto {
    if (!isMetrics(value)) return false;
    const row = value as unknown as Record<string, unknown>;
    return (row.groupId === null || (typeof row.groupId === 'number' && Number.isInteger(row.groupId) && row.groupId >= 1))
        && (row.groupName === null || typeof row.groupName === 'string');
}

/**
 * True only for a report of exactly this range and grouping, with the shape and the figures this service produces.
 * Whatever Redis holds is untrusted: a value from an older version or edited by hand is recomputed, never served.
 */
export function isSlaReportOf(value: unknown, from: string, to: string, groupBy: SlaGroupBy): value is SlaReportDto {
    if (typeof value !== 'object' || value === null) return false;
    const report = value as Record<string, unknown>;
    return report.from === from && report.to === to && report.groupBy === groupBy
        && isMetrics(report.totals) && Array.isArray(report.rows) && report.rows.every(isRow);
}
