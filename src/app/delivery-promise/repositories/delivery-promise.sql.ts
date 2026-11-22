import { OPERATING_TIME_ZONE } from '../../../modules/dispatch/dispatches/utils/operating-date.util.js';

/**
 * Pieces of SQL the queries of ST-301.1 share. Parameters are always the same, in this order:
 * `$1` from, `$2` to (Bolivia days), `$3` zone id, `$4` service-level id, `$5` current status (each of the last three may be
 * NULL = no filter) and `$6` the moment of the query. Nothing here is built from user text.
 */
export interface DeliveryPromiseFilters {
    from: string;
    to: string;
    zoneId?: number;
    serviceLevelId?: number;
    status?: string;
}

export function filterParams(filters: DeliveryPromiseFilters, now: Date): [string, string, number | null, number | null, string | null, Date] {
    return [filters.from, filters.to, filters.zoneId ?? null, filters.serviceLevelId ?? null, filters.status ?? null, now];
}

// Whole Bolivia days: `from` starts at 00:00 of its day and `to` includes all of its day (same rule as ES-54).
export const FROM_TS = `($1::date)::timestamp AT TIME ZONE '${OPERATING_TIME_ZONE}'`;
export const TO_TS = `(($2::date + 1)::timestamp AT TIME ZONE '${OPERATING_TIME_ZONE}')`;

/** The optional filters of the dashboard, over the dispatch `d` and its current status `s`. */
export const FILTERS_SQL = `($3::int IS NULL OR d.delivery_zone_id = $3::int)
           AND ($4::int IS NULL OR d.service_level_id = $4::int)
           AND ($5::text IS NULL OR s.name = $5::text)`;

/** A window that can be measured against: both ends present and the end not before the start. */
export const VALID_WINDOW_SQL = '(d.scheduled_window_start IS NOT NULL AND d.scheduled_window_end IS NOT NULL AND d.scheduled_window_end >= d.scheduled_window_start)';
