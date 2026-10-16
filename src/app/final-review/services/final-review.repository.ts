import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
    DELIVERY_MAINTAINED_SENT_EVENT,
    FINAL_REVIEW_ESCALATED_EVENT,
    RISK_NOTICE_SENT_EVENT,
    ROUTE_REMINDER_SENT_EVENT,
} from '../final-review-events.js';

export interface EscalationDispatchRow extends NoticeDispatchRow {
    /** The case 5.2 incident of this order was already registered. */
    escalated: boolean;
}

export interface NoticeDispatchRow {
    dispatchId: number;
    contactEmail: string | null;
    trackingToken: string | null;
    windowStart: Date | null;
    windowEnd: Date | null;
    reminderSent: boolean;
    riskNoticeSent: boolean;
    maintainedSent: boolean;
}

export interface FinalReviewBatchRow {
    routeBatchId: number;
    status: string;
    shiftDate: string;
    reviewerUserId: number | null;
    dispatchCount: number;
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

    /** Orders of a batch that are `assigned`, with what has already been sent to each customer. */
    async findNoticeDispatches(routeBatchId: number): Promise<NoticeDispatchRow[]> {
        const rows: Array<{
            id: number; contact_email: string | null; tracking_token: string | null;
            scheduled_window_start: Date | null; scheduled_window_end: Date | null;
            reminder_sent: boolean; risk_notice_sent: boolean; maintained_sent: boolean;
        }> = await this.dataSource.query(
            `SELECT d.dispatch_id AS id, d.contact_email, d.tracking_token, d.scheduled_window_start, d.scheduled_window_end,
                    EXISTS (SELECT 1 FROM dispatch_events e WHERE e.dispatch_id = d.dispatch_id AND e.event_type = $2) AS reminder_sent,
                    EXISTS (SELECT 1 FROM dispatch_events e WHERE e.dispatch_id = d.dispatch_id AND e.event_type = $3) AS risk_notice_sent,
                    EXISTS (SELECT 1 FROM dispatch_events e WHERE e.dispatch_id = d.dispatch_id AND e.event_type = $4) AS maintained_sent
               FROM dispatches d
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
              WHERE d.route_batch_id = $1 AND s.name = 'assigned'
              ORDER BY d.dispatch_id`,
            [routeBatchId, ROUTE_REMINDER_SENT_EVENT, RISK_NOTICE_SENT_EVENT, DELIVERY_MAINTAINED_SENT_EVENT],
        );
        return rows.map((row) => ({
            dispatchId: row.id,
            contactEmail: row.contact_email,
            trackingToken: row.tracking_token,
            windowStart: row.scheduled_window_start,
            windowEnd: row.scheduled_window_end,
            reminderSent: row.reminder_sent,
            riskNoticeSent: row.risk_notice_sent,
            maintainedSent: row.maintained_sent,
        }));
    }

    /**
     * Orders of a batch whose promise the customer was already told (`scheduled`, `promise_notified_at` set):
     * the ones the escalation protects. An order still in planning was never promised, so nobody is owed anything.
     */
    async findEscalationDispatches(routeBatchId: number): Promise<EscalationDispatchRow[]> {
        const rows: Array<{
            id: number; contact_email: string | null; tracking_token: string | null;
            scheduled_window_start: Date | null; scheduled_window_end: Date | null;
            reminder_sent: boolean; risk_notice_sent: boolean; maintained_sent: boolean; escalated: boolean;
        }> = await this.dataSource.query(
            `SELECT d.dispatch_id AS id, d.contact_email, d.tracking_token, d.scheduled_window_start, d.scheduled_window_end,
                    EXISTS (SELECT 1 FROM dispatch_events e WHERE e.dispatch_id = d.dispatch_id AND e.event_type = $2) AS reminder_sent,
                    EXISTS (SELECT 1 FROM dispatch_events e WHERE e.dispatch_id = d.dispatch_id AND e.event_type = $3) AS risk_notice_sent,
                    EXISTS (SELECT 1 FROM dispatch_events e WHERE e.dispatch_id = d.dispatch_id AND e.event_type = $4) AS maintained_sent,
                    EXISTS (SELECT 1 FROM dispatch_events e WHERE e.dispatch_id = d.dispatch_id AND e.event_type = $5) AS escalated
               FROM dispatches d
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
              WHERE d.route_batch_id = $1 AND s.name = 'scheduled' AND d.promise_notified_at IS NOT NULL
              ORDER BY d.dispatch_id`,
            [routeBatchId, ROUTE_REMINDER_SENT_EVENT, RISK_NOTICE_SENT_EVENT, DELIVERY_MAINTAINED_SENT_EVENT, FINAL_REVIEW_ESCALATED_EVENT],
        );
        return rows.map((row) => ({
            dispatchId: row.id,
            contactEmail: row.contact_email,
            trackingToken: row.tracking_token,
            windowStart: row.scheduled_window_start,
            windowEnd: row.scheduled_window_end,
            reminderSent: row.reminder_sent,
            riskNoticeSent: row.risk_notice_sent,
            maintainedSent: row.maintained_sent,
            escalated: row.escalated,
        }));
    }

    /** Id of the active `INC-COMP-FAILURE` reason (company failure, case 5.2), or `null` when it is not seeded. */
    async findCompanyFailureReasonId(): Promise<number | null> {
        const rows: Array<{ id: number }> = await this.dataSource.query(
            `SELECT incident_reason_id AS id FROM incident_reasons WHERE code = 'INC-COMP-FAILURE' AND deleted_at IS NULL`,
        );
        return rows[0]?.id ?? null;
    }

    /**
     * Case 5.2 for one order, in one transaction: the `final_review_escalated` event (once per order) and an
     * `INC-COMP-FAILURE` incident. The order keeps its status, version, day and window: the original promise
     * stands, and the reason does not count as a delivery attempt (`counts_as_attempt = false`).
     * Returns the incident id, or `null` when the order was already escalated.
     */
    async registerCompanyFailure(dispatchId: number, incidentReasonId: number, metadata: Record<string, unknown>): Promise<string | null> {
        return await this.dataSource.transaction(async (manager) => {
            const claimed: unknown[] = await manager.query(
                `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, reason, metadata)
                 SELECT $1::int, $2::varchar, 'system', 'Second approval still pending at final_review_escalation_time (case 5.2)', $3::jsonb
                  WHERE NOT EXISTS (SELECT 1 FROM dispatch_events e WHERE e.dispatch_id = $1::int AND e.event_type = $2::varchar)
                 RETURNING dispatch_event_id`,
                [dispatchId, FINAL_REVIEW_ESCALATED_EVENT, JSON.stringify(metadata)],
            );
            if (claimed.length === 0) return null;
            const incident: Array<{ id: string }> = await manager.query(
                `INSERT INTO dispatch_incidents (dispatch_incident_id, dispatch_id, incident_reason_id, description)
                 VALUES (gen_random_uuid(), $1, $2, $3)
                 RETURNING dispatch_incident_id AS id`,
                [dispatchId, incidentReasonId, 'The route batch was not approved by final_review_escalation_time; the original promise is kept.'],
            );
            return incident[0].id;
        });
    }

    /** Same as `recordBatchEventOnce`, for an order: true when this call wrote the event. */
    async claimDispatchEvent(dispatchId: number, eventType: string, reason: string, metadata: Record<string, unknown>): Promise<boolean> {
        const rows: unknown[] = await this.dataSource.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, reason, metadata)
             SELECT $1::int, $2::varchar, 'system', $3::text, $4::jsonb
              WHERE NOT EXISTS (SELECT 1 FROM dispatch_events e WHERE e.dispatch_id = $1::int AND e.event_type = $2::varchar)
             RETURNING dispatch_event_id`,
            [dispatchId, eventType, reason, JSON.stringify(metadata)],
        );
        return rows.length > 0;
    }

    /** A follow-up for the coordinator (the same record a bounced promise email leaves). */
    async recordContactManagement(routeBatchId: number, dispatchId: number, reason: string, metadata: Record<string, unknown>): Promise<void> {
        await this.dataSource.query(
            `INSERT INTO route_batch_events (route_batch_id, dispatch_id, event_type, actor_type, reason, metadata)
             VALUES ($1, $2, 'contact_management_required', 'system', $3, $4::jsonb)`,
            [routeBatchId, dispatchId, reason, JSON.stringify(metadata)],
        );
    }

    /**
     * Writes a batch event only if the batch has none of `eventType` yet and is still in one of
     * `requiredStatuses`, in a single statement, so two instances (or a re-run) cannot both win.
     * Returns whether this call wrote it.
     */
    async recordBatchEventOnce(
        routeBatchId: number,
        eventType: string,
        requiredStatuses: readonly string[],
        reason: string,
        metadata: Record<string, unknown>,
        manager?: EntityManager,
    ): Promise<boolean> {
        const runner = manager ?? this.dataSource;
        const rows: unknown[] = await runner.query(
            `INSERT INTO route_batch_events (route_batch_id, event_type, actor_type, reason, metadata)
             SELECT b.route_batch_id, $2::varchar, 'system', $4::text, $5::jsonb
               FROM route_batches b
              WHERE b.route_batch_id = $1::int
                AND b.status = ANY($3::text[])
                AND NOT EXISTS (SELECT 1 FROM route_batch_events e WHERE e.route_batch_id = b.route_batch_id AND e.event_type = $2::varchar)
             RETURNING route_batch_event_id`,
            [routeBatchId, eventType, [...requiredStatuses], reason, JSON.stringify(metadata)],
        );
        return rows.length > 0;
    }
}
