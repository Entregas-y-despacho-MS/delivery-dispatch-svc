import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
    CONTACT_MANAGEMENT_REQUIRED_EVENT,
    DELIVERY_MAINTAINED_SENT_EVENT,
    FINAL_REVIEW_ESCALATED_EVENT,
    RISK_NOTICE_FAILED_EVENT,
    RISK_NOTICE_SENT_EVENT,
    ROUTE_REMINDER_SENT_EVENT,
} from '../final-review-events.js';

export interface FinalReviewBatchRow {
    routeBatchId: number;
    status: string;
    shiftDate: string;
    reviewerUserId: number | null;
    dispatchCount: number;
}

/** What is known about one order of a batch, read while the batch is locked. Flags are for THIS batch. */
export interface DispatchNoticeState {
    dispatchId: number;
    /** `dispatch_statuses.name` of the order. */
    status: string;
    contactEmail: string | null;
    trackingToken: string | null;
    windowStart: Date | null;
    windowEnd: Date | null;
    promiseNotifiedAt: Date | null;
    reminderSent: boolean;
    /** The risk notice was reserved and did not fail: the customer was warned. */
    riskNoticeSent: boolean;
    maintainedSent: boolean;
    /** The case 5.2 incident of this order, for this batch, was already registered. */
    escalated: boolean;
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
        const batch = String(this.routeBatchId);
        const rows: Array<{
            status: string; contact_email: string | null; tracking_token: string | null;
            scheduled_window_start: Date | null; scheduled_window_end: Date | null; promise_notified_at: Date | null;
            reminder_sent: boolean; risk_sent: boolean; risk_failed: boolean; maintained_sent: boolean; escalated: boolean;
        }> = await this.manager.query(
            `SELECT s.name AS status, d.contact_email, d.tracking_token, d.scheduled_window_start, d.scheduled_window_end,
                    d.promise_notified_at,
                    EXISTS (SELECT 1 FROM dispatch_events e WHERE e.dispatch_id = d.dispatch_id AND e.event_type = $3 AND e.metadata->>'routeBatchId' = $2) AS reminder_sent,
                    EXISTS (SELECT 1 FROM dispatch_events e WHERE e.dispatch_id = d.dispatch_id AND e.event_type = $4 AND e.metadata->>'routeBatchId' = $2) AS risk_sent,
                    EXISTS (SELECT 1 FROM dispatch_events e WHERE e.dispatch_id = d.dispatch_id AND e.event_type = $5 AND e.metadata->>'routeBatchId' = $2) AS risk_failed,
                    EXISTS (SELECT 1 FROM dispatch_events e WHERE e.dispatch_id = d.dispatch_id AND e.event_type = $6 AND e.metadata->>'routeBatchId' = $2) AS maintained_sent,
                    EXISTS (SELECT 1 FROM dispatch_events e WHERE e.dispatch_id = d.dispatch_id AND e.event_type = $7 AND e.metadata->>'routeBatchId' = $2) AS escalated
               FROM dispatches d
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
              WHERE d.dispatch_id = $1 AND d.route_batch_id = $8::int`,
            [
                dispatchId, batch, ROUTE_REMINDER_SENT_EVENT, RISK_NOTICE_SENT_EVENT, RISK_NOTICE_FAILED_EVENT,
                DELIVERY_MAINTAINED_SENT_EVENT, FINAL_REVIEW_ESCALATED_EVENT, this.routeBatchId,
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
            reminderSent: row.reminder_sent,
            riskNoticeSent: row.risk_sent && !row.risk_failed,
            maintainedSent: row.maintained_sent,
            escalated: row.escalated,
        };
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
     * After a bounce or failure: the coordinator must contact the customer. For the risk notice also
     * records that the customer was NOT warned, so a later approval does not say «tu entrega se mantiene».
     * Not under the batch lock: it only appends events.
     */
    async recordSendFailure(
        routeBatchId: number,
        dispatchId: number,
        template: string,
        result: 'bounced' | 'failed',
        reason: string,
        failureEventType?: string,
    ): Promise<void> {
        await this.dataSource.transaction(async (manager) => {
            const scope = new BatchScope(routeBatchId, '', manager);
            await scope.recordContactManagementOnce(dispatchId, template, reason, { category: 'customer_contact', deliveryResult: result });
            if (failureEventType) await scope.claimDispatchEvent(dispatchId, failureEventType, reason, { template, deliveryResult: result });
        });
    }
}
