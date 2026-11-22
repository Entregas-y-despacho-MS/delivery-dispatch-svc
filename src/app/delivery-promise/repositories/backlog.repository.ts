import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ACTIVE_DISPATCH_STATUSES, AGE_RANGE_BOUNDS, type AgeRange } from '../domain/backlog-buckets.js';
import type { BacklogRow, OpenOverdueRow } from '../domain/backlog-report.js';
import { FILTERS_SQL, FROM_TS, TO_TS, VALID_WINDOW_SQL, filterParams, type DeliveryPromiseFilters } from './delivery-promise.sql.js';

const ACTIVE_STATUSES_SQL = ACTIVE_DISPATCH_STATUSES.map((status) => `'${status}'`).join(', ');

/** The age range of a dispatch from its minutes in the stage, built from the same bounds the domain uses (a negative age is the youngest). No age (a finished dispatch) is no range. */
const AGE_RANGE_SQL = `CASE WHEN s.age_minutes IS NULL THEN NULL ${AGE_RANGE_BOUNDS.map(({ range, maxMinutesExclusive }) =>
    maxMinutesExclusive === null ? `ELSE '${range}'` : `WHEN s.age_minutes < ${maxMinutesExclusive} THEN '${range}'`,
).join(' ')} END`;

/**
 * The delivery dispatches of the filters, each with what the summary needs. The promise date a dispatch is placed by is the
 * end of its window; one without a window has no promise, so it is placed by its closing time (finished ones) or by its
 * creation (the ones still waiting to be planned), which keeps them in the backlog instead of dropping them.
 *
 * - `overdue`: active, with a valid window that ended before the cut (`$6`). An invalid window is never overdue.
 * - `age_minutes`: how long it has been in its current stage, from the last `status_changed` event that put it in this status
 *   (the new status is `metadata.status`, but the planner writes it as `metadata.to`), or the last update when there is none. Only active dispatches have one.
 */
const STAGED_SQL = `
    WITH base AS (
        SELECT d.dispatch_id, d.tracking_code, d.delivery_zone_id, d.service_level_id, d.updated_at, d.created_at,
               s.name AS status, d.scheduled_window_end AS window_end, ${VALID_WINDOW_SQL} AS valid_window
          FROM dispatches d
          JOIN dispatch_types t ON t.dispatch_type_id = d.dispatch_type_id AND t.name = 'delivery'
          JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
         WHERE ${FILTERS_SQL}
           AND COALESCE(d.scheduled_window_end, d.closed_at, d.created_at) >= ${FROM_TS}
           AND COALESCE(d.scheduled_window_end, d.closed_at, d.created_at) < ${TO_TS}
    ), staged AS (
        SELECT b.*,
               (b.status IN (${ACTIVE_STATUSES_SQL}) AND b.valid_window AND b.window_end < $6::timestamptz) AS overdue,
               CASE WHEN b.status IN (${ACTIVE_STATUSES_SQL})
                    THEN EXTRACT(EPOCH FROM ($6::timestamptz - COALESCE(ev.entered_at, b.updated_at, b.created_at))) / 60.0 END AS age_minutes
          FROM base b
          LEFT JOIN LATERAL (
              SELECT e.created_at AS entered_at
                FROM dispatch_events e
               WHERE b.status IN (${ACTIVE_STATUSES_SQL})
                 AND e.dispatch_id = b.dispatch_id
                 AND e.event_type = 'status_changed'
                 AND COALESCE(e.metadata->>'status', e.metadata->>'to') = b.status
               ORDER BY e.created_at DESC, e.dispatch_event_id DESC
               LIMIT 1
          ) ev ON TRUE
    )`;

/** Counts by status, overdue or not and age range: the app turns each group into its bucket. */
export const BACKLOG_COUNTS_SQL = `${STAGED_SQL}
    SELECT s.status, s.overdue, ${AGE_RANGE_SQL} AS age_range, COUNT(*)::int AS count
      FROM staged s
     GROUP BY s.status, s.overdue, age_range`;

/** The open overdue dispatches, the most overdue first. `$7` is the size of the list. */
export const OPEN_OVERDUE_SQL = `${STAGED_SQL}
    SELECT s.dispatch_id, s.tracking_code, s.status, s.delivery_zone_id, s.service_level_id, s.window_end,
           FLOOR(EXTRACT(EPOCH FROM ($6::timestamptz - s.window_end)) / 60.0)::int AS overdue_minutes
      FROM staged s
     WHERE s.overdue
     ORDER BY s.window_end ASC, s.dispatch_id ASC
     LIMIT $7::int`;

interface BacklogCountRow {
    status: string;
    overdue: boolean;
    age_range: AgeRange | null;
    count: number;
}

interface OpenOverdueSqlRow {
    dispatch_id: number;
    tracking_code: string | null;
    status: string;
    delivery_zone_id: number | null;
    service_level_id: number | null;
    window_end: Date;
    overdue_minutes: number;
}

/** The volume of the backlog computed by PostgreSQL: counts by status for the summary, and a short list of the oldest open overdue dispatches. */
@Injectable()
export class BacklogRepository {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async countByStatus(filters: DeliveryPromiseFilters, now: Date): Promise<BacklogRow[]> {
        const rows: BacklogCountRow[] = await this.dataSource.query(BACKLOG_COUNTS_SQL, filterParams(filters, now));
        return rows.map((row) => ({ status: row.status, overdue: row.overdue, ageRange: row.age_range, count: row.count }));
    }

    async listOpenOverdue(filters: DeliveryPromiseFilters, now: Date, limit: number): Promise<OpenOverdueRow[]> {
        const rows: OpenOverdueSqlRow[] = await this.dataSource.query(OPEN_OVERDUE_SQL, [...filterParams(filters, now), limit]);
        return rows.map((row) => ({
            dispatchId: row.dispatch_id,
            trackingCode: row.tracking_code,
            status: row.status,
            zoneId: row.delivery_zone_id,
            serviceLevelId: row.service_level_id,
            promiseEnd: new Date(row.window_end),
            overdueMinutes: row.overdue_minutes,
        }));
    }
}
