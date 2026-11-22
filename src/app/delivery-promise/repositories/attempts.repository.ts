import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DispatchStatusEnum } from '../../../shared/enums/dispatch-status.enum.js';
import { IN_TRANSIT, type AttemptEvent } from '../domain/first-attempt.js';
import { FILTERS_SQL, FROM_TS, TO_TS, filterParams, type DeliveryPromiseFilters } from './delivery-promise.sql.js';

/** The status an event moved the dispatch to: `metadata.status` in almost every writer, `metadata.to` in the planner. */
const EVENT_STATUS_SQL = "COALESCE(e.metadata->>'status', e.metadata->>'to')";

/** The only statuses that matter to an attempt: the trip that starts it and the results that end it. */
const ATTEMPT_STATUSES_SQL = [IN_TRANSIT, DispatchStatusEnum.DELIVERED, DispatchStatusEnum.NOT_DELIVERED, DispatchStatusEnum.INCIDENT]
    .map((status) => `'${status}'`)
    .join(', ');

/**
 * The delivery dispatches of the filters with the status events their attempts are rebuilt from (ST-301.3), one row per
 * dispatch. The range places a dispatch like the backlog does (end of its window; else its closing; else its creation), so
 * the ones that have not had their first chance yet are in the answer and can be counted apart.
 *
 * `countsAsAttempt` is the reason's `counts_as_attempt` for an incident (the event's `reason` is the reason code) and FALSE
 * for any other event. Only the filters are parameters (`$1`..`$5`): the cut is not needed, events are never in the future.
 */
export const ATTEMPT_EVENTS_SQL = `
    SELECT d.dispatch_id, d.scheduled_window_start AS window_start, d.scheduled_window_end AS window_end,
           COALESCE(ev.events, '[]'::json) AS events
      FROM dispatches d
      JOIN dispatch_types t ON t.dispatch_type_id = d.dispatch_type_id AND t.name = 'delivery'
      JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
      LEFT JOIN LATERAL (
          SELECT json_agg(json_build_object(
                     'eventId', e.dispatch_event_id,
                     'clientEventId', e.client_event_id,
                     'occurredAt', e.created_at,
                     'previousStatus', e.metadata->>'previousStatus',
                     'status', ${EVENT_STATUS_SQL},
                     'countsAsAttempt', COALESCE((SELECT BOOL_OR(ir.counts_as_attempt) FROM incident_reasons ir WHERE ir.code = e.reason), FALSE)
                 ) ORDER BY e.created_at, e.dispatch_event_id) AS events
            FROM dispatch_events e
           WHERE e.dispatch_id = d.dispatch_id
             AND e.event_type = 'status_changed'
             AND ${EVENT_STATUS_SQL} IN (${ATTEMPT_STATUSES_SQL})
      ) ev ON TRUE
     WHERE ${FILTERS_SQL}
       AND COALESCE(d.scheduled_window_end, d.closed_at, d.created_at) >= ${FROM_TS}
       AND COALESCE(d.scheduled_window_end, d.closed_at, d.created_at) < ${TO_TS}
     ORDER BY d.dispatch_id`;

/**
 * Where the instrumented period starts: the first change to `in_transit` the backend wrote with its previous status and its
 * author. A result with no such trip before it is history from before the instrumentation and cannot be rebuilt.
 */
export const FIRST_INSTRUMENTED_SQL = `
    SELECT MIN(e.created_at) AS first_at
      FROM dispatch_events e
     WHERE e.event_type = 'status_changed'
       AND ${EVENT_STATUS_SQL} = '${IN_TRANSIT}'
       AND e.metadata->>'previousStatus' IS NOT NULL
       AND e.actor_type IS NOT NULL`;

export interface DispatchAttemptSource {
    dispatchId: number;
    windowStart: Date | null;
    windowEnd: Date | null;
    events: AttemptEvent[];
}

interface AttemptEventJson {
    eventId: number;
    clientEventId: string | null;
    occurredAt: string;
    previousStatus: string | null;
    status: string | null;
    countsAsAttempt: boolean;
}

interface AttemptRow {
    dispatch_id: number;
    window_start: Date | null;
    window_end: Date | null;
    events: AttemptEventJson[];
}

/** Reads the events of the dispatches in the range; the rule that turns them into attempts is in `domain/first-attempt.ts`. */
@Injectable()
export class AttemptsRepository {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async listSources(filters: DeliveryPromiseFilters): Promise<DispatchAttemptSource[]> {
        const rows: AttemptRow[] = await this.dataSource.query(ATTEMPT_EVENTS_SQL, filterParams(filters, new Date()).slice(0, 5));
        return rows.map((row) => ({
            dispatchId: row.dispatch_id,
            windowStart: row.window_start ? new Date(row.window_start) : null,
            windowEnd: row.window_end ? new Date(row.window_end) : null,
            events: row.events.map((event) => ({ ...event, occurredAt: new Date(event.occurredAt) })),
        }));
    }

    /** `null` when the backend has not written any trip yet: nothing can be rebuilt. */
    async findFirstInstrumentedAt(): Promise<Date | null> {
        const rows: { first_at: Date | null }[] = await this.dataSource.query(FIRST_INSTRUMENTED_SQL);
        const firstAt = rows[0]?.first_at;
        return firstAt ? new Date(firstAt) : null;
    }
}
