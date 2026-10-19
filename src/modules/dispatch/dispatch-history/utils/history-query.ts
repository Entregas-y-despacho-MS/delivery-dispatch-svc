import { OPERATING_TIME_ZONE } from '../../dispatches/utils/operating-date.util.js';
import { TERMINAL_DISPATCH_STATUSES } from '../../dispatches/utils/terminal-statuses.js';
import { escapeLike } from '../../../../shared/utils/like.util.js';
import { DispatchHistorySortBy, type DispatchHistoryFiltersDto, type DispatchHistorySortDto } from '../dto/find-dispatch-history-params.dto.js';
import { InvalidHistoryDateRangeException } from '../exceptions/index.js';

/**
 * The history is the dispatches that reached a terminal status. The driver and the vehicle come from
 * the route; a dispatch without a route (or a route without driver or vehicle) still appears, with
 * those fields empty. Users and vehicles are joined with soft-deleted rows included on purpose: a
 * driver or a vehicle that was removed later is still who made the trip.
 */
export const HISTORY_FROM_SQL = `
    FROM dispatches d
    JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
    LEFT JOIN route_batches rb ON rb.route_batch_id = d.route_batch_id
    LEFT JOIN users u ON u.user_id = rb.driver_id
    LEFT JOIN vehicles v ON v.vehicle_id = rb.vehicle_id`;

// The ids are constants of the enum, never user text. `closed_at IS NOT NULL` is what lets Postgres use
// the partial index `idx_dispatches_closed_at`; a terminal dispatch always has it (database trigger).
const TERMINAL_SQL = `s.name IN (${TERMINAL_DISPATCH_STATUSES.map((status) => `'${status}'`).join(', ')}) AND d.closed_at IS NOT NULL`;

// Whitelist: the value that reaches ORDER BY is always one of these, never user text.
const SORT_SQL: Record<DispatchHistorySortBy, string> = {
    [DispatchHistorySortBy.CLOSED_AT]:     'd.closed_at',
    [DispatchHistorySortBy.TRACKING_CODE]: 'd.tracking_code',
    [DispatchHistorySortBy.RECIPIENT]:     'LOWER(d.contact_name)',
    [DispatchHistorySortBy.DRIVER]:        'LOWER(u.full_name)',
    [DispatchHistorySortBy.PLATE]:         'v.plate',
    [DispatchHistorySortBy.STATUS]:        's.name',
};

export interface HistoryQuery {
    whereSql: string;
    orderSql: string;
    args: unknown[];
    /** Adds a value to the bound parameters and returns its placeholder (`$n`). */
    bind: (value: unknown) => string;
}

/**
 * WHERE and ORDER BY of the history, shared by the listing and the CSV export so that the export
 * applies exactly the filters the screen shows. Every value travels as a bound parameter.
 */
export function buildHistoryQuery(params: DispatchHistoryFiltersDto & DispatchHistorySortDto): HistoryQuery {
    if (params.from && params.to && params.from > params.to) throw new InvalidHistoryDateRangeException();

    const args: unknown[] = [];
    const bind = (value: unknown): string => { args.push(value); return `$${args.length}`; };

    const where: string[] = [TERMINAL_SQL];
    // Whole Bolivia days: `from` starts at 00:00 of its day, `to` includes all of its day.
    if (params.from) where.push(`d.closed_at >= (${bind(params.from)}::date)::timestamp AT TIME ZONE '${OPERATING_TIME_ZONE}'`);
    if (params.to) where.push(`d.closed_at < ((${bind(params.to)}::date + 1)::timestamp AT TIME ZONE '${OPERATING_TIME_ZONE}')`);
    if (params.driverId !== undefined) where.push(`rb.driver_id = ${bind(params.driverId)}`);
    if (params.plate) where.push(`v.plate ILIKE ${bind(`%${escapeLike(params.plate)}%`)}`);
    if (params.status) where.push(`s.name = ${bind(params.status)}`);
    if (params.search) where.push(`d.tracking_code ILIKE ${bind(`%${escapeLike(params.search)}%`)}`);

    // Default: most recent first. Every order ends in the id, so a page never repeats or skips a row when
    // the sorted field ties. `closed_at` is never NULL here, so it needs no NULLS clause (which would also
    // keep Postgres from reading it straight off the index).
    const sortBy = params.sortBy ?? DispatchHistorySortBy.CLOSED_AT;
    const direction = (params.order ?? 'desc') === 'asc' ? 'ASC' : 'DESC';
    const sortSql = SORT_SQL[sortBy];
    // The DTO validates `sortBy` already; this keeps a value from outside the whitelist out of the SQL if it ever gets here.
    if (!sortSql) throw new Error(`Unsupported history sort field: ${String(sortBy)}`);
    const orderSql = sortBy === DispatchHistorySortBy.CLOSED_AT
        ? `ORDER BY d.closed_at ${direction}, d.dispatch_id ${direction}`
        : `ORDER BY ${sortSql} ${direction} NULLS LAST, d.dispatch_id DESC`;

    return { whereSql: `WHERE ${where.join(' AND ')}`, orderSql, args, bind };
}
