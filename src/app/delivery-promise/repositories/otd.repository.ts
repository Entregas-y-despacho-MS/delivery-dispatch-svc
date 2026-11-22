import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DispatchStatusEnum } from '../../../shared/enums/dispatch-status.enum.js';
import type { OtdCounts } from '../domain/otd-metrics.js';
import { FILTERS_SQL, FROM_TS, TO_TS, VALID_WINDOW_SQL, filterParams, type DeliveryPromiseFilters } from './delivery-promise.sql.js';

/** Finished after being tried: they had a promise to keep, so a missing window is a data problem, not «not planned yet». */
const EXECUTED_STATUSES_SQL = [DispatchStatusEnum.DELIVERED, DispatchStatusEnum.NOT_DELIVERED, DispatchStatusEnum.RETURNED, DispatchStatusEnum.RETURNED_TO_WAREHOUSE]
    .map((status) => `'${status}'`)
    .join(', ');

/**
 * The window in force when a cancelled dispatch was cancelled, rebuilt from the append-only reschedule log: the last
 * window change made before the cancellation; else the window the first later change replaced (the original promise);
 * else the current one. NULL when no usable window can be found (then the cancellation cannot be placed).
 */
const CANCELLATION_PROMISE_END_SQL = `COALESCE(
                   (SELECT r.new_window_end FROM dispatch_reschedules r
                     WHERE r.dispatch_id = d.dispatch_id
                       AND r.new_window_start IS NOT NULL AND r.new_window_end IS NOT NULL AND r.new_window_end >= r.new_window_start
                       AND r.created_at <= d.closed_at
                     ORDER BY r.created_at DESC, r.dispatch_reschedule_id DESC LIMIT 1),
                   (SELECT r.previous_window_end FROM dispatch_reschedules r
                     WHERE r.dispatch_id = d.dispatch_id
                       AND r.previous_window_start IS NOT NULL AND r.previous_window_end IS NOT NULL AND r.previous_window_end >= r.previous_window_start
                     ORDER BY r.created_at ASC, r.dispatch_reschedule_id ASC LIMIT 1),
                   CASE WHEN ${VALID_WINDOW_SQL} THEN d.scheduled_window_end END)`;

/**
 * OTD by cohort of promise (ST-301.1, RF-A07 semantics widened). Every delivery dispatch is classified once (`kind`) and
 * anchored to the date its promise is measured on (`anchor`); the cohort is the dispatches whose anchor falls inside the
 * range and has already passed.
 *
 * - `eligible`: valid window (or, for a cancelled one, the window in force when it was cancelled) whose end is the anchor.
 *   Open, failed, returned and late ones are in the denominator as not on time. A cancelled one is eligible only if it was
 *   cancelled after the promise expired.
 * - `excluded`: cancelled on or before the end of the promise in force.
 * - `unreconstructable`: cancelled, and no window to tell (anchored to its closing time).
 * - `invalid`: window with the end before the start, or a finished dispatch without window (anchored to its closing time).
 * - `none`: no promise yet (not planned) or nothing to say: it is not part of the rate.
 */
export const OTD_COHORT_SQL = `
    WITH base AS (
        SELECT s.name AS status, d.closed_at, d.scheduled_window_start AS window_start, d.scheduled_window_end AS window_end,
               ${VALID_WINDOW_SQL} AS valid_window,
               (d.scheduled_window_start IS NOT NULL AND d.scheduled_window_end IS NOT NULL) AS has_window,
               EXISTS (SELECT 1 FROM dispatch_reschedules r WHERE r.dispatch_id = d.dispatch_id AND r.previous_window_end IS NOT NULL) AS promise_changed,
               CASE WHEN s.name = '${DispatchStatusEnum.CANCELLED}' THEN ${CANCELLATION_PROMISE_END_SQL} END AS cancellation_promise_end
          FROM dispatches d
          JOIN dispatch_types t ON t.dispatch_type_id = d.dispatch_type_id AND t.name = 'delivery'
          JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
         WHERE ${FILTERS_SQL}
    ), classified AS (
        SELECT b.*,
               CASE
                   WHEN b.status = '${DispatchStatusEnum.CANCELLED}' THEN
                       CASE WHEN b.closed_at IS NULL OR b.cancellation_promise_end IS NULL THEN 'unreconstructable'
                            WHEN b.closed_at <= b.cancellation_promise_end THEN 'excluded'
                            ELSE 'eligible' END
                   WHEN b.valid_window THEN 'eligible'
                   WHEN b.has_window THEN 'invalid'
                   WHEN b.status IN (${EXECUTED_STATUSES_SQL}) AND b.closed_at IS NOT NULL THEN 'invalid'
                   ELSE 'none'
               END AS kind
          FROM base b
    ), anchored AS (
        SELECT c.*,
               CASE
                   WHEN c.kind IN ('eligible', 'excluded') AND c.status = '${DispatchStatusEnum.CANCELLED}' THEN c.cancellation_promise_end
                   WHEN c.kind IN ('eligible', 'excluded') OR (c.kind = 'invalid' AND c.has_window) THEN c.window_end
                   ELSE c.closed_at
               END AS anchor
          FROM classified c
         WHERE c.kind <> 'none'
    )
    SELECT COUNT(*) FILTER (WHERE a.kind = 'eligible')::int AS eligible,
           COUNT(*) FILTER (
               WHERE a.kind = 'eligible' AND a.status = '${DispatchStatusEnum.DELIVERED}' AND a.closed_at BETWEEN a.window_start AND a.window_end
           )::int AS on_time,
           COUNT(*) FILTER (WHERE a.kind = 'invalid')::int AS invalid_window,
           COUNT(*) FILTER (WHERE a.kind = 'excluded')::int AS excluded_cancellations,
           COUNT(*) FILTER (WHERE a.kind = 'unreconstructable')::int AS unreconstructable_cancellations,
           COUNT(*) FILTER (WHERE a.kind = 'eligible' AND a.promise_changed)::int AS rescheduled_promise
      FROM anchored a
     WHERE a.anchor >= ${FROM_TS}
       AND a.anchor < ${TO_TS}
       AND a.anchor < $6::timestamptz`;

/**
 * The historic punctuality of the completed deliveries (`basis=deliveredAt`): the delivered dispatches closed inside the
 * range, measured against the window in force when they were delivered. It is the ES-54 rule (`/reports/sla`, left
 * untouched) with one difference: a delivery without a valid window is shown apart (`invalid`), not counted as late.
 * Cancellations are not completed deliveries: they are only counted, with their reason. `$6` caps the closing time at the cut.
 */
export const OTD_DELIVERED_AT_SQL = `
    SELECT COUNT(*) FILTER (WHERE s.name = '${DispatchStatusEnum.DELIVERED}' AND ${VALID_WINDOW_SQL})::int AS eligible,
           COUNT(*) FILTER (
               WHERE s.name = '${DispatchStatusEnum.DELIVERED}' AND ${VALID_WINDOW_SQL} AND d.closed_at BETWEEN d.scheduled_window_start AND d.scheduled_window_end
           )::int AS on_time,
           COUNT(*) FILTER (WHERE s.name = '${DispatchStatusEnum.DELIVERED}' AND NOT ${VALID_WINDOW_SQL})::int AS invalid_window,
           COUNT(*) FILTER (WHERE s.name = '${DispatchStatusEnum.CANCELLED}')::int AS excluded_cancellations,
           0::int AS unreconstructable_cancellations,
           COUNT(*) FILTER (
               WHERE s.name = '${DispatchStatusEnum.DELIVERED}' AND ${VALID_WINDOW_SQL}
                 AND EXISTS (SELECT 1 FROM dispatch_reschedules r WHERE r.dispatch_id = d.dispatch_id AND r.previous_window_end IS NOT NULL)
           )::int AS rescheduled_promise
      FROM dispatches d
      JOIN dispatch_types t ON t.dispatch_type_id = d.dispatch_type_id AND t.name = 'delivery'
      JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
     WHERE ${FILTERS_SQL}
       AND s.name IN ('${DispatchStatusEnum.DELIVERED}', '${DispatchStatusEnum.CANCELLED}')
       AND d.closed_at >= ${FROM_TS}
       AND d.closed_at < ${TO_TS}
       AND d.closed_at <= $6::timestamptz`;

interface OtdCohortRow {
    eligible: number;
    on_time: number;
    invalid_window: number;
    excluded_cancellations: number;
    unreconstructable_cancellations: number;
    rescheduled_promise: number;
}

/** The counts of the OTD by cohort of promise, computed by PostgreSQL: the app only receives the counts, never the dispatches. */
@Injectable()
export class OtdRepository {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    /** `filters.from` and `filters.to` are Bolivia days (`YYYY-MM-DD`), both included; the caller has already validated the range. */
    async countCohort(filters: DeliveryPromiseFilters, now: Date): Promise<OtdCounts> {
        return await this.count(OTD_COHORT_SQL, filters, now);
    }

    /** The counts of the historic punctuality by closing time (`basis=deliveredAt`), same shape and same filters. */
    async countDeliveredAt(filters: DeliveryPromiseFilters, now: Date): Promise<OtdCounts> {
        return await this.count(OTD_DELIVERED_AT_SQL, filters, now);
    }

    private async count(sql: string, filters: DeliveryPromiseFilters, now: Date): Promise<OtdCounts> {
        const rows: OtdCohortRow[] = await this.dataSource.query(sql, filterParams(filters, now));
        const row = rows[0];
        return {
            eligible: row?.eligible ?? 0,
            onTime: row?.on_time ?? 0,
            invalidWindow: row?.invalid_window ?? 0,
            excludedCancellations: row?.excluded_cancellations ?? 0,
            unreconstructableCancellations: row?.unreconstructable_cancellations ?? 0,
            rescheduledPromise: row?.rescheduled_promise ?? 0,
        };
    }
}
