import { OPERATING_TIME_ZONE } from '../../dispatches/utils/operating-date.util.js';
import type { ComplaintCaseFiltersDto } from '../dto/find-complaint-cases-params.dto.js';
import { InvalidComplaintDateRangeException } from '../exceptions/index.js';

/**
 * Case + dispatch (status, zone, route batch) + the users involved. Users are joined with soft-deleted rows
 * included on purpose: whoever took or decided a case stays visible after being removed. `LEFT JOIN` on the
 * dispatch side so a case never disappears from the inbox because of a missing zone or batch.
 */
export const COMPLAINT_CASES_FROM_SQL = `
    FROM delivery_complaint_cases c
    JOIN dispatches d ON d.dispatch_id = c.dispatch_id
    JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
    LEFT JOIN delivery_zones z ON z.delivery_zone_id = d.delivery_zone_id
    LEFT JOIN route_batches rb ON rb.route_batch_id = d.route_batch_id
    LEFT JOIN users au ON au.user_id = c.assigned_user_id
    LEFT JOIN users du ON du.user_id = c.decided_by_user_id`;

export interface ComplaintCasesQuery {
    whereSql: string;
    args: unknown[];
    /** Adds a value to the bound parameters and returns its placeholder (`$n`). */
    bind: (value: unknown) => string;
}

/** WHERE of the inbox: every value travels as a bound parameter, never inside the SQL text. */
export function buildComplaintCasesQuery(filters: ComplaintCaseFiltersDto): ComplaintCasesQuery {
    if (filters.from && filters.to && filters.from > filters.to) throw new InvalidComplaintDateRangeException();

    const args: unknown[] = [];
    const bind = (value: unknown): string => { args.push(value); return `$${args.length}`; };

    const where: string[] = [];
    // Whole Bolivia days: `from` starts at 00:00 of its day, `to` includes all of its day.
    if (filters.from) where.push(`c.consumed_at >= (${bind(filters.from)}::date)::timestamp AT TIME ZONE '${OPERATING_TIME_ZONE}'`);
    if (filters.to) where.push(`c.consumed_at < ((${bind(filters.to)}::date + 1)::timestamp AT TIME ZONE '${OPERATING_TIME_ZONE}')`);
    if (filters.zoneId !== undefined) where.push(`d.delivery_zone_id = ${bind(filters.zoneId)}`);
    if (filters.reasonCode) where.push(`LOWER(c.reason_code) = ${bind(filters.reasonCode.toLowerCase())}`);
    if (filters.status) where.push(`c.investigation_status = ${bind(filters.status)}`);
    if (filters.assignedUserId !== undefined) where.push(`c.assigned_user_id = ${bind(filters.assignedUserId)}`);

    return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', args, bind };
}
