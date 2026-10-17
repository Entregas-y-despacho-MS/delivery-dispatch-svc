import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import type { NoticeStatus } from '../domain/final-review-timeline.js';
import {
    CONTACT_MANAGEMENT_REQUIRED_EVENT,
    FINAL_REVIEW_ESCALATED_EVENT,
    NOTICE_LEASE_MINUTES,
    NOTICE_RESERVED_EVENT,
    NOTICE_RESULT_EVENT,
    type NoticeResult,
} from '../final-review-events.js';

/** `metadata.template` of each customer email (the names of the `.hbs` files). */
export type NoticeTemplate = 'reminder' | 'risk-notice' | 'delivery-maintained';

export interface FinalReviewBatchRow {
    routeBatchId: number;
    status: string;
    shiftDate: string;
    reviewerUserId: number | null;
    dispatchCount: number;
}

/** What is known about one order of a batch, read while the batch is locked. Statuses are for THIS batch. */
export interface DispatchNoticeState {
    dispatchId: number;
    /** `dispatch_statuses.name` of the order. */
    status: string;
    contactEmail: string | null;
    trackingToken: string | null;
    windowStart: Date | null;
    windowEnd: Date | null;
    promiseNotifiedAt: Date | null;
    reminder: NoticeStatus;
    risk: NoticeStatus;
    maintained: NoticeStatus;
    /** The case 5.2 incident of this order, for this batch, was already registered. */
    escalated: boolean;
}

/** A reservation that never got a result and whose lease ran out: the process died or the transport hung. */
export interface AbandonedNotice {
    routeBatchId: number;
    dispatchId: number;
    template: NoticeTemplate;
}

/**
 * One customer email as a status in SQL. `reserved_at` is the reservation, `result` the latest result; the
 * lease is measured with the clock of the database (`NOW()`), the same one that stamped the reservation.
 * Parameters: $2 batch (text), $3 result event, $4 reservation event, $5 lease minutes.
 */
function noticeJoin(alias: string, template: NoticeTemplate): string {
    return `LEFT JOIN LATERAL (
                SELECT MAX(r.created_at) AS reserved_at,
                       (SELECT x.metadata->>'result' FROM dispatch_events x
                         WHERE x.dispatch_id = d.dispatch_id AND x.event_type = $3
                           AND x.metadata->>'routeBatchId' = $2 AND x.metadata->>'template' = '${template}'
                         ORDER BY x.created_at DESC, x.dispatch_event_id DESC LIMIT 1) AS result
                  FROM dispatch_events r
                 WHERE r.dispatch_id = d.dispatch_id AND r.event_type = $4
                   AND r.metadata->>'routeBatchId' = $2 AND r.metadata->>'template' = '${template}'
            ) ${alias} ON TRUE`;
}

function noticeStatus(alias: string): string {
    return `CASE WHEN ${alias}.reserved_at IS NULL THEN 'none'
                 WHEN ${alias}.result = 'sent' THEN 'sent'
                 WHEN ${alias}.result IS NOT NULL THEN 'failed'
                 WHEN ${alias}.reserved_at > NOW() - make_interval(mins => $5::int) THEN 'in_flight'
                 ELSE 'failed' END`;
}

/**
 * Everything done inside `FinalReviewRepository.inBatchLock`: the batch row is locked `FOR UPDATE`, so the
 * 2nd approval (which locks the batch first, then its orders) and the other callers of this timeline wait
 * their turn. The reads below therefore see a state that cannot change until the transaction ends, and
 * "write it only if it is not there yet" is really atomic (a `NOT EXISTS` alone is not, in READ COMMITTED).
 * Each statement takes a fresh snapshot, so the claim sees what the previous lock holder committed.
 */
export class BatchScope {
    constructor(
        readonly routeBatchId: number,
        /** Status of the batch, read under the lock. */
        readonly status: string,
        readonly manager: EntityManager,
    ) {}

    async dispatchState(dispatchId: number): Promise<DispatchNoticeState | null> {
        const rows: Array<{
            status: string; contact_email: string | null; tracking_token: string | null;
            scheduled_window_start: Date | null; scheduled_window_end: Date | null; promise_notified_at: Date | null;
            reminder: NoticeStatus; risk: NoticeStatus; maintained: NoticeStatus; escalated: boolean;
        }> = await this.manager.query(
            `SELECT s.name AS status, d.contact_email, d.tracking_token, d.scheduled_window_start, d.scheduled_window_end,
                    d.promise_notified_at,
                    ${noticeStatus('n_reminder')} AS reminder,
                    ${noticeStatus('n_risk')} AS risk,
                    ${noticeStatus('n_maintained')} AS maintained,
                    EXISTS (SELECT 1 FROM dispatch_events e WHERE e.dispatch_id = d.dispatch_id
                               AND e.event_type = $6 AND e.metadata->>'routeBatchId' = $2) AS escalated
               FROM dispatches d
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
               ${noticeJoin('n_reminder', 'reminder')}
               ${noticeJoin('n_risk', 'risk-notice')}
               ${noticeJoin('n_maintained', 'delivery-maintained')}
              WHERE d.dispatch_id = $1 AND d.route_batch_id = $7::int`,
            [
                dispatchId, String(this.routeBatchId), NOTICE_RESULT_EVENT, NOTICE_RESERVED_EVENT, NOTICE_LEASE_MINUTES,
                FINAL_REVIEW_ESCALATED_EVENT, this.routeBatchId,
            ],
        );
        const row = rows[0];
        if (!row) return null;
        return {
            dispatchId,
            status: row.status,
            contactEmail: row.contact_email,
            trackingToken: row.tracking_token,
            windowStart: row.scheduled_window_start,
            windowEnd: row.scheduled_window_end,
            promiseNotifiedAt: row.promise_notified_at,
            reminder: row.reminder,
            risk: row.risk,
            maintained: row.maintained,
            escalated: row.escalated,
        };
    }

    /**
     * Reserves a customer email for this order and batch unless one is already reserved (in any state);
     * true when this call reserved it. This is the only thing that stops a second send.
     */
    async reserveNotice(dispatchId: number, template: NoticeTemplate, reason: string): Promise<boolean> {
        const rows: unknown[] = await this.manager.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, reason, metadata)
             SELECT $1::int, $2::varchar, 'system', $3::text, $4::jsonb
              WHERE NOT EXISTS (
                    SELECT 1 FROM dispatch_events e
                     WHERE e.dispatch_id = $1::int AND e.event_type = $2::varchar
                       AND e.metadata->>'routeBatchId' = $5::text AND e.metadata->>'template' = $6::text)
             RETURNING dispatch_event_id`,
            [dispatchId, NOTICE_RESERVED_EVENT, reason, JSON.stringify({ template, routeBatchId: this.routeBatchId }), String(this.routeBatchId), template],
        );
        return rows.length > 0;
    }

    /** Appends how a reserved email ended. The latest result of a template is the one that counts. */
    async recordNoticeResult(dispatchId: number, template: NoticeTemplate, result: NoticeResult, reason: string): Promise<void> {
        await this.manager.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, reason, metadata)
             VALUES ($1, $2, 'system', $3, $4::jsonb)`,
            [dispatchId, NOTICE_RESULT_EVENT, reason, JSON.stringify({ template, result, routeBatchId: this.routeBatchId })],
        );
    }

    /**
     * Closes a reservation that never got a result and whose lease ran out (the process died or the transport
     * hung): writes the result `abandoned` and opens the coordinator follow-up. Re-checks both conditions under
     * the lock, so a late real result or another sweep cannot be doubled; true when this call closed it.
     * It does not resend: the email may have left before the crash, so a person decides.
     */
    async abandonNotice(dispatchId: number, template: NoticeTemplate): Promise<boolean> {
        const rows: unknown[] = await this.manager.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, reason, metadata)
             SELECT $1::int, $2::varchar, 'system', $3::text, $4::jsonb
              WHERE EXISTS (
                    SELECT 1 FROM dispatch_events r
                     WHERE r.dispatch_id = $1::int AND r.event_type = $5::varchar
                       AND r.metadata->>'routeBatchId' = $6::text AND r.metadata->>'template' = $7::text
                       AND r.created_at <= NOW() - make_interval(mins => $8::int))
                AND NOT EXISTS (
                    SELECT 1 FROM dispatch_events x
                     WHERE x.dispatch_id = $1::int AND x.event_type = $2::varchar
                       AND x.metadata->>'routeBatchId' = $6::text AND x.metadata->>'template' = $7::text)
             RETURNING dispatch_event_id`,
            [
                dispatchId, NOTICE_RESULT_EVENT, 'Email reservation outlived its lease without a result; coordinator must contact the customer',
                JSON.stringify({ template, result: 'abandoned', routeBatchId: this.routeBatchId }),
                NOTICE_RESERVED_EVENT, String(this.routeBatchId), template, NOTICE_LEASE_MINUTES,
            ],
        );
        if (rows.length === 0) return false;
        await this.recordContactManagementOnce(dispatchId, template, 'Email reservation outlived its lease without a result; coordinator must contact the customer', {
            category: 'customer_contact', deliveryResult: 'abandoned',
        });
        return true;
    }

    /** Writes an order event for this batch unless it already has one; true when this call wrote it. */
    async claimDispatchEvent(dispatchId: number, eventType: string, reason: string, metadata: Record<string, unknown>): Promise<boolean> {
        const rows: unknown[] = await this.manager.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, reason, metadata)
             SELECT $1::int, $2::varchar, 'system', $3::text, $4::jsonb
              WHERE NOT EXISTS (
                    SELECT 1 FROM dispatch_events e
                     WHERE e.dispatch_id = $1::int AND e.event_type = $2::varchar AND e.metadata->>'routeBatchId' = $5::text)
             RETURNING dispatch_event_id`,
            [dispatchId, eventType, reason, JSON.stringify({ ...metadata, routeBatchId: this.routeBatchId }), String(this.routeBatchId)],
        );
        return rows.length > 0;
    }

    /**
     * Case 5.2 for one order: an `INC-COMP-FAILURE` incident (it does not count as a delivery attempt).
     * The order keeps its status, version, day and window: the original promise stands.
     */
    async registerIncident(dispatchId: number, incidentReasonId: number): Promise<string> {
        const rows: Array<{ id: string }> = await this.manager.query(
            `INSERT INTO dispatch_incidents (dispatch_incident_id, dispatch_id, incident_reason_id, description)
             VALUES (gen_random_uuid(), $1, $2, $3)
             RETURNING dispatch_incident_id AS id`,
            [dispatchId, incidentReasonId, 'The route batch was not approved by final_review_escalation_time; the original promise is kept.'],
        );
        return rows[0].id;
    }

    /** Writes an event of this batch unless it already has one of that type; true when this call wrote it. */
    async recordBatchEventOnce(eventType: string, reason: string, metadata: Record<string, unknown>): Promise<boolean> {
        const rows: unknown[] = await this.manager.query(
            `INSERT INTO route_batch_events (route_batch_id, event_type, actor_type, reason, metadata)
             SELECT $1::int, $2::varchar, 'system', $3::text, $4::jsonb
              WHERE NOT EXISTS (SELECT 1 FROM route_batch_events e WHERE e.route_batch_id = $1::int AND e.event_type = $2::varchar)
             RETURNING route_batch_event_id`,
            [this.routeBatchId, eventType, reason, JSON.stringify(metadata)],
        );
        return rows.length > 0;
    }

    /** A follow-up for the coordinator (a customer who cannot be reached), once per order and template. */
    async recordContactManagementOnce(dispatchId: number, template: string, reason: string, metadata: Record<string, unknown>): Promise<void> {
        await this.manager.query(
            `INSERT INTO route_batch_events (route_batch_id, dispatch_id, event_type, actor_type, reason, metadata)
             SELECT $1::int, $2::int, $3::varchar, 'system', $4::text, $5::jsonb
              WHERE NOT EXISTS (
                    SELECT 1 FROM route_batch_events e
                     WHERE e.route_batch_id = $1::int AND e.dispatch_id = $2::int AND e.event_type = $3::varchar AND e.metadata->>'template' = $6::text)`,
            [this.routeBatchId, dispatchId, CONTACT_MANAGEMENT_REQUIRED_EVENT, reason, JSON.stringify({ ...metadata, template }), template],
        );
    }
}

/**
 * Reads and the idempotency record of the 2nd-approval timeline (ST-51.4). Raw SQL on purpose: like the
 * scheduler and the cutoff, this logic belongs to no single table.
 */
@Injectable()
export class FinalReviewRepository {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    /** Batches of a route day in any of `statuses`, with how many orders each holds. */
    async findBatches(shiftDate: string, statuses: readonly string[]): Promise<FinalReviewBatchRow[]> {
        const rows: Array<{ id: number; status: string; shift_date: string; reviewer_user_id: number | null; dispatch_count: string }> =
            await this.dataSource.query(
                `SELECT b.route_batch_id AS id, b.status, to_char(b.shift_date, 'YYYY-MM-DD') AS shift_date,
                        b.reviewer_user_id,
                        (SELECT COUNT(*) FROM dispatches d WHERE d.route_batch_id = b.route_batch_id) AS dispatch_count
                   FROM route_batches b
                  WHERE b.shift_date = $1 AND b.status = ANY($2::text[])
                  ORDER BY b.route_batch_id`,
                [shiftDate, [...statuses]],
            );
        return rows.map((row) => ({
            routeBatchId: row.id,
            status: row.status,
            shiftDate: row.shift_date,
            reviewerUserId: row.reviewer_user_id,
            dispatchCount: Number(row.dispatch_count),
        }));
    }

    /** Batches whose route day is between two dates (both included), in any of `statuses`. */
    async findBatchesInRange(from: string, to: string, statuses: readonly string[]): Promise<FinalReviewBatchRow[]> {
        const rows: Array<{ id: number; status: string; shift_date: string; reviewer_user_id: number | null }> =
            await this.dataSource.query(
                `SELECT route_batch_id AS id, status, to_char(shift_date, 'YYYY-MM-DD') AS shift_date, reviewer_user_id
                   FROM route_batches
                  WHERE shift_date BETWEEN $1 AND $2 AND status = ANY($3::text[])
                  ORDER BY shift_date, route_batch_id`,
                [from, to, [...statuses]],
            );
        return rows.map((row) => ({
            routeBatchId: row.id, status: row.status, shiftDate: row.shift_date, reviewerUserId: row.reviewer_user_id, dispatchCount: 0,
        }));
    }

    /**
     * Reservations of this batch with no result whose lease ran out. A pre-filter: each one is re-checked under the
     * lock by `BatchScope.abandonNotice`. Looked up through the orders of the batch (indexed), not by event type.
     */
    async findAbandonedNotices(routeBatchId: number): Promise<AbandonedNotice[]> {
        const rows: Array<{ dispatch_id: number; template: NoticeTemplate }> = await this.dataSource.query(
            `SELECT r.dispatch_id, r.metadata->>'template' AS template
               FROM dispatch_events r
              WHERE r.dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE route_batch_id = $1)
                AND r.event_type = $2 AND r.metadata->>'routeBatchId' = $3
                AND r.created_at <= NOW() - make_interval(mins => $4::int)
                AND NOT EXISTS (
                    SELECT 1 FROM dispatch_events x
                     WHERE x.dispatch_id = r.dispatch_id AND x.event_type = $5
                       AND x.metadata->>'routeBatchId' = $3 AND x.metadata->>'template' = r.metadata->>'template')
              ORDER BY r.dispatch_id`,
            [routeBatchId, NOTICE_RESERVED_EVENT, String(routeBatchId), NOTICE_LEASE_MINUTES, NOTICE_RESULT_EVENT],
        );
        return rows.map((row) => ({ routeBatchId, dispatchId: row.dispatch_id, template: row.template }));
    }

    /**
     * Orders of a batch that are `assigned` and have no reminder and no «se mantiene» reserved yet: the only ones
     * that can still be owed a notice, so the reconciliation does not take a lock for every order every time.
     */
    async findAssignedWithoutNotice(routeBatchId: number): Promise<number[]> {
        const rows: Array<{ id: number }> = await this.dataSource.query(
            `SELECT d.dispatch_id AS id
               FROM dispatches d
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
              WHERE d.route_batch_id = $1 AND s.name = 'assigned'
                AND NOT EXISTS (
                    SELECT 1 FROM dispatch_events e
                     WHERE e.dispatch_id = d.dispatch_id AND e.event_type = $2 AND e.metadata->>'routeBatchId' = $3
                       AND e.metadata->>'template' IN ('reminder', 'delivery-maintained'))
              ORDER BY d.dispatch_id`,
            [routeBatchId, NOTICE_RESERVED_EVENT, String(routeBatchId)],
        );
        return rows.map((row) => row.id);
    }

    /** Route day and status of one batch, or `null` when it does not exist. */
    async findBatch(routeBatchId: number): Promise<{ routeBatchId: number; status: string; shiftDate: string } | null> {
        const rows: Array<{ id: number; status: string; shift_date: string }> = await this.dataSource.query(
            `SELECT route_batch_id AS id, status, to_char(shift_date, 'YYYY-MM-DD') AS shift_date
               FROM route_batches WHERE route_batch_id = $1`,
            [routeBatchId],
        );
        return rows[0] ? { routeBatchId: rows[0].id, status: rows[0].status, shiftDate: rows[0].shift_date } : null;
    }

    /** Ids of the orders of a batch in a given status: a cheap pre-filter, every id is re-read under the lock. */
    async findDispatchIds(routeBatchId: number, statusName: string, onlyPromised: boolean): Promise<number[]> {
        const rows: Array<{ id: number }> = await this.dataSource.query(
            `SELECT d.dispatch_id AS id
               FROM dispatches d
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
              WHERE d.route_batch_id = $1 AND s.name = $2 AND ($3::boolean = FALSE OR d.promise_notified_at IS NOT NULL)
              ORDER BY d.dispatch_id`,
            [routeBatchId, statusName, onlyPromised],
        );
        return rows.map((row) => row.id);
    }

    /** Id of the active `INC-COMP-FAILURE` reason (company failure, case 5.2), or `null` when it is not seeded. */
    async findCompanyFailureReasonId(): Promise<number | null> {
        const rows: Array<{ id: number }> = await this.dataSource.query(
            `SELECT incident_reason_id AS id FROM incident_reasons WHERE code = 'INC-COMP-FAILURE' AND deleted_at IS NULL`,
        );
        return rows[0]?.id ?? null;
    }

    /**
     * Runs `work` in a short transaction with the batch row locked `FOR UPDATE`; `null` when the batch does
     * not exist. Keep `work` to database statements: never send an email while holding the lock.
     */
    async inBatchLock<T>(routeBatchId: number, work: (scope: BatchScope) => Promise<T>): Promise<T | null> {
        return await this.dataSource.transaction(async (manager) => {
            const rows: Array<{ status: string }> = await manager.query(
                `SELECT status FROM route_batches WHERE route_batch_id = $1 FOR UPDATE`,
                [routeBatchId],
            );
            if (!rows[0]) return null;
            return await work(new BatchScope(routeBatchId, rows[0].status, manager));
        });
    }

    /**
     * Records how a reserved email ended. Anything but `sent` also opens the coordinator follow-up (the customer
     * must be contacted). Not under the batch lock: it only appends events, and the latest result wins.
     */
    async recordNoticeResult(
        routeBatchId: number,
        dispatchId: number,
        template: NoticeTemplate,
        result: NoticeResult,
        reason: string,
    ): Promise<void> {
        await this.dataSource.transaction(async (manager) => {
            const scope = new BatchScope(routeBatchId, '', manager);
            await scope.recordNoticeResult(dispatchId, template, result, reason);
            if (result !== 'sent') {
                await scope.recordContactManagementOnce(dispatchId, template, reason, { category: 'customer_contact', deliveryResult: result });
            }
        });
    }
}
