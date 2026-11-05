import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OPERATING_TIME_ZONE } from '../../../modules/dispatch/dispatches/utils/operating-date.util.js';
import { TERMINAL_DISPATCH_STATUSES } from '../../../modules/dispatch/dispatches/utils/terminal-statuses.js';
import { DispatchStatusEnum } from '../../../shared/enums/dispatch-status.enum.js';
import { SlaGroupBy } from '../domain/sla-group-by.js';
import type { SlaGroupSums } from '../domain/sla-metrics.js';

/**
 * The statuses that count as «closed» for the report: the terminal ones except `cancelled`. A dispatch cancelled
 * before it left (the coordinator, Marketplace or Purchasing cancel it) says nothing about how well deliveries are
 * made, and it has no driver, so it would only inflate the group «without driver».
 */
export const SLA_CLOSED_STATUSES: readonly DispatchStatusEnum[] = TERMINAL_DISPATCH_STATUSES.filter((status) => status !== DispatchStatusEnum.CANCELLED);

// Whole Bolivia days: `from` starts at 00:00 of its day and `to` includes all of its day (same rule as the history and the driver metrics).
const FROM_TS = `($1::date)::timestamp AT TIME ZONE '${OPERATING_TIME_ZONE}'`;
const TO_TS = `(($2::date + 1)::timestamp AT TIME ZONE '${OPERATING_TIME_ZONE}')`;

const CLOSED_STATUSES_SQL = SLA_CLOSED_STATUSES.map((status) => `'${status}'`).join(', ');

// «Iniciar ruta» writes `departedAt` in the metadata of the `out_for_delivery` event (the history reads it the same
// way). `toISOString()` is the only writer, so the format is fixed; the guard keeps a malformed value, written by
// hand, from making the cast fail and take the whole report down: it falls back to the time of the event.
const DEPARTED_AT_SQL = `CASE WHEN e.metadata->>'departedAt' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$'
                                 THEN (e.metadata->>'departedAt')::timestamptz
                                 ELSE e.created_at END`;

interface GroupDefinition {
    /** Joins that bring the group; `d` is the dispatch, `rb` its route and `g` the group's table. */
    joinSql: string;
    idSql: string;
    nameSql: string;
    /** Extra condition on the group, when the grouping has one. */
    whereSql?: string;
}

// Whitelist: the SQL of a grouping is always one of these, never built from user text. Zones, service levels and users
// are joined with their soft-deleted rows included on purpose: a zone, a level or a driver removed later is still who
// the dispatch belonged to (same as the history).
const GROUPS: Record<SlaGroupBy, GroupDefinition> = {
    [SlaGroupBy.ZONE]: {
        joinSql: 'LEFT JOIN delivery_zones g ON g.delivery_zone_id = d.delivery_zone_id',
        idSql: 'd.delivery_zone_id',
        nameSql: 'g.name',
    },
    [SlaGroupBy.SERVICE_LEVEL]: {
        joinSql: 'LEFT JOIN service_levels g ON g.service_level_id = d.service_level_id',
        idSql: 'd.service_level_id',
        nameSql: 'g.name',
        // Only the levels that are active are reported (Express stays off); a dispatch with no level is still counted.
        whereSql: '(d.service_level_id IS NULL OR g.active)',
    },
    [SlaGroupBy.DRIVER]: {
        joinSql: 'LEFT JOIN users g ON g.user_id = rb.driver_id',
        idSql: 'rb.driver_id',
        nameSql: 'g.full_name',
    },
};

/**
 * One aggregate query per grouping. The CTE picks the closed delivery dispatches of the range, once, with what each one
 * needs (its group, its window, its departure and its incidents); the outer query only counts and sums. It returns
 * sums, not averages: the totals are built from them in `buildSlaReport`.
 */
function buildSql(group: GroupDefinition): string {
    return `
    WITH closed AS (
        SELECT s.name AS status, d.closed_at, d.scheduled_window_start, d.scheduled_window_end,
               ${group.idSql} AS group_id, ${group.nameSql} AS group_name,
               dep.departed_at,
               (SELECT COUNT(*) FROM dispatch_incidents i WHERE i.dispatch_id = d.dispatch_id)::int AS incident_count
          FROM dispatches d
          JOIN dispatch_types t ON t.dispatch_type_id = d.dispatch_type_id AND t.name = 'delivery'
          JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
          LEFT JOIN route_batches rb ON rb.route_batch_id = d.route_batch_id
          ${group.joinSql}
          LEFT JOIN LATERAL (
              SELECT ${DEPARTED_AT_SQL} AS departed_at
                FROM dispatch_events e
               WHERE e.dispatch_id = d.dispatch_id
                 AND e.event_type = 'status_changed'
                 AND e.metadata->>'status' = '${DispatchStatusEnum.OUT_FOR_DELIVERY}'
                 AND s.name = '${DispatchStatusEnum.DELIVERED}'
               ORDER BY e.created_at DESC, e.dispatch_event_id DESC
               LIMIT 1
          ) dep ON TRUE
         WHERE s.name IN (${CLOSED_STATUSES_SQL})
           AND d.closed_at IS NOT NULL
           AND d.closed_at >= ${FROM_TS}
           AND d.closed_at < ${TO_TS}
           ${group.whereSql ? `AND ${group.whereSql}` : ''}
    )
    SELECT c.group_id, c.group_name,
           COUNT(*)::int AS closed_count,
           COUNT(*) FILTER (WHERE c.status = '${DispatchStatusEnum.DELIVERED}')::int AS delivered_count,
           COUNT(*) FILTER (
               WHERE c.status = '${DispatchStatusEnum.DELIVERED}'
                 AND c.scheduled_window_start IS NOT NULL AND c.scheduled_window_end IS NOT NULL
                 AND c.closed_at BETWEEN c.scheduled_window_start AND c.scheduled_window_end
           )::int AS on_time_count,
           COUNT(*) FILTER (
               WHERE c.status = '${DispatchStatusEnum.DELIVERED}'
                 AND c.scheduled_window_end IS NOT NULL AND c.closed_at > c.scheduled_window_end
           )::int AS late_count,
           COALESCE(SUM(EXTRACT(EPOCH FROM (c.closed_at - c.scheduled_window_end)) / 60.0) FILTER (
               WHERE c.status = '${DispatchStatusEnum.DELIVERED}'
                 AND c.scheduled_window_end IS NOT NULL AND c.closed_at > c.scheduled_window_end
           ), 0)::float8 AS delay_minutes_sum,
           COUNT(*) FILTER (
               WHERE c.status = '${DispatchStatusEnum.DELIVERED}' AND c.departed_at IS NOT NULL AND c.closed_at >= c.departed_at
           )::int AS cycle_count,
           COALESCE(SUM(EXTRACT(EPOCH FROM (c.closed_at - c.departed_at)) / 60.0) FILTER (
               WHERE c.status = '${DispatchStatusEnum.DELIVERED}' AND c.departed_at IS NOT NULL AND c.closed_at >= c.departed_at
           ), 0)::float8 AS cycle_minutes_sum,
           COALESCE(SUM(c.incident_count), 0)::int AS incident_count
      FROM closed c
     GROUP BY c.group_id, c.group_name
     ORDER BY c.group_name NULLS LAST, c.group_id`;
}

/** The SQL of every grouping is built once, when the module loads. */
export const SLA_REPORT_SQL: Readonly<Record<SlaGroupBy, string>> = {
    [SlaGroupBy.ZONE]: buildSql(GROUPS[SlaGroupBy.ZONE]),
    [SlaGroupBy.SERVICE_LEVEL]: buildSql(GROUPS[SlaGroupBy.SERVICE_LEVEL]),
    [SlaGroupBy.DRIVER]: buildSql(GROUPS[SlaGroupBy.DRIVER]),
};

interface SlaGroupRow {
    group_id: number | null;
    group_name: string | null;
    closed_count: number;
    delivered_count: number;
    on_time_count: number;
    late_count: number;
    delay_minutes_sum: number;
    cycle_count: number;
    cycle_minutes_sum: number;
    incident_count: number;
}

/** The aggregations of RF-A07 computed by PostgreSQL: the app only receives the sums of each group, never the dispatches. */
@Injectable()
export class SlaReportRepository {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    /** `from` and `to` are Bolivia days (`YYYY-MM-DD`), both included; the caller has already validated the range. */
    async aggregate(groupBy: SlaGroupBy, from: string, to: string): Promise<SlaGroupSums[]> {
        const sql = SLA_REPORT_SQL[groupBy];
        // The DTO validates `groupBy` already; this keeps a value from outside the whitelist out of the query if it ever gets here.
        if (!sql) throw new Error(`Unsupported SLA report grouping: ${String(groupBy)}`);
        const rows: SlaGroupRow[] = await this.dataSource.query(sql, [from, to]);
        return rows.map((row) => ({
            groupId: row.group_id,
            groupName: row.group_name,
            closedCount: row.closed_count,
            deliveredCount: row.delivered_count,
            onTimeCount: row.on_time_count,
            lateCount: row.late_count,
            delayMinutesSum: row.delay_minutes_sum,
            cycleCount: row.cycle_count,
            cycleMinutesSum: row.cycle_minutes_sum,
            incidentCount: row.incident_count,
        }));
    }
}
