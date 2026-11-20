import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ATTEMPT_LEASE_MINUTES } from '../domain/delivery-policy.js';
import type { StatusNoticeDispatch } from '../domain/build-status-notice.js';

/** A notification to register: everything `customer_notifications` keeps about the email before it is sent. */
export interface NewNotification {
    dispatchId: number;
    notificationType: string;
    /** Unique: the source event and the type of notification. A second registration of it is refused. */
    idempotencyKey: string;
    sourceEventKey: string;
    dispatchStatus: string;
    /** ISO instant of the transition. */
    occurredAt: string;
    /** Already normalized. */
    recipient: string;
    template: string;
    templateVersion: number;
}

/** How a round of attempts ended. `retrying` and `exhausted` follow a transient failure. */
export interface NotificationOutcome {
    status: 'sent' | 'bounced' | 'retrying' | 'exhausted';
    /** Attempts made in this round (they are added to the ones already counted). */
    attemptsMade: number;
    /** When the recovery task should try again; `null` unless `status` is `retrying`. */
    nextAttemptAt: Date | null;
    /** Sanitized; `null` when the email was sent. */
    lastError: string | null;
}

/** An email the recovery task took over: what is needed to rebuild it and try again. */
export interface ClaimedNotification {
    notificationId: number;
    dispatchId: number;
    dispatchStatus: string;
    /** ISO instant of the transition. */
    occurredAt: string;
    /** As it was registered: the address is not read again from the dispatch. */
    recipient: string;
    /** Attempts already counted, including the one a dead process left unrecorded. */
    attempts: number;
    /** Proof that this process owns the row; `recordOutcome` needs it. */
    lease: string;
}

/** A registered email this process owns: its id and the lease that proves it. */
export interface ReservedNotification {
    notificationId: number;
    /** The `locked_until` of the reservation as text (exact to the microsecond); `recordOutcome` needs it. */
    lease: string;
}

@Injectable()
export class CustomerStatusNoticeRepository {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async findDispatch(dispatchId: number): Promise<StatusNoticeDispatch | null> {
        const rows: Array<{
            type: string; status: string; contact_email: string | null; tracking_code: string | null;
            tracking_token: string | null; tracking_token_expires_at: Date | null;
        }> = await this.dataSource.query(
            `SELECT t.name AS type, s.name AS status, d.contact_email, d.tracking_code, d.tracking_token, d.tracking_token_expires_at
               FROM dispatches d
               JOIN dispatch_types t ON t.dispatch_type_id = d.dispatch_type_id
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
              WHERE d.dispatch_id = $1`,
            [dispatchId],
        );
        const row = rows[0];
        if (!row) return null;
        return {
            dispatchId,
            type: row.type,
            currentStatus: row.status,
            contactEmail: row.contact_email,
            trackingCode: row.tracking_code,
            trackingToken: row.tracking_token,
            trackingTokenExpiresAt: row.tracking_token_expires_at,
        };
    }

    /**
     * Registers the email and takes it for this process: the new row with its lease, or `null` when the idempotency
     * key is already registered (a second delivery of the same event, or a concurrent copy of it). The unique index
     * decides, so no lock is needed. The row starts `sending` with a lease: if this process dies before it records
     * the outcome, the recovery task finds the row once the lease runs out.
     */
    async reserve(notification: NewNotification): Promise<ReservedNotification | null> {
        const rows: Array<{ customer_notification_id: number; lease: string }> = await this.dataSource.query(
            `INSERT INTO customer_notifications
                    (dispatch_id, notification_type, idempotency_key, source_event_key, dispatch_status, occurred_at,
                     recipient, template, template_version, status, next_attempt_at, locked_until)
             VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, 'sending',
                     NOW() + make_interval(mins => $10::int), NOW() + make_interval(mins => $10::int))
             ON CONFLICT (idempotency_key) DO NOTHING
             RETURNING customer_notification_id, locked_until::text AS lease`,
            [
                notification.dispatchId, notification.notificationType, notification.idempotencyKey, notification.sourceEventKey,
                notification.dispatchStatus, notification.occurredAt, notification.recipient, notification.template,
                notification.templateVersion, ATTEMPT_LEASE_MINUTES,
            ],
        );
        return rows[0] ? { notificationId: rows[0].customer_notification_id, lease: rows[0].lease } : null;
    }

    /**
     * Takes over, for the recovery task, up to `limit` emails that are due: `retrying` with their next attempt reached,
     * and `sending` whose lease ran out (the process died or hung before it recorded the outcome). Each one is
     * leased again, so a second run sees it as in flight; `FOR UPDATE SKIP LOCKED` keeps two concurrent runs from
     * taking the same row. An expired `sending` counts one attempt, because the dead process did try: that bounds a
     * row that kills its process every time.
     */
    async claimDue(limit: number): Promise<ClaimedNotification[]> {
        const [rows]: [Array<{
            customer_notification_id: number; dispatch_id: number; dispatch_status: string; occurred_at: Date; recipient: string; attempts: number;
            lease: string;
        }>, number] = await this.dataSource.query(
            `UPDATE customer_notifications c
                SET attempts = c.attempts + CASE WHEN c.status = 'sending' THEN 1 ELSE 0 END,
                    status = 'sending',
                    locked_until = NOW() + make_interval(mins => $2::int),
                    next_attempt_at = NOW() + make_interval(mins => $2::int)
              WHERE c.customer_notification_id IN (
                    SELECT customer_notification_id FROM customer_notifications
                     WHERE status IN ('sending', 'retrying') AND next_attempt_at <= NOW()
                     ORDER BY next_attempt_at, customer_notification_id
                     LIMIT $1
                       FOR UPDATE SKIP LOCKED)
              RETURNING c.customer_notification_id, c.dispatch_id, c.dispatch_status, c.occurred_at, c.recipient, c.attempts,
                        c.locked_until::text AS lease`,
            [limit, ATTEMPT_LEASE_MINUTES],
        );
        return rows.map((row) => ({
            notificationId: row.customer_notification_id,
            dispatchId: row.dispatch_id,
            dispatchStatus: row.dispatch_status,
            occurredAt: row.occurred_at.toISOString(),
            recipient: row.recipient,
            attempts: row.attempts,
            lease: row.lease,
        }));
    }

    /**
     * Writes how a round of attempts ended and releases the lease. It only writes while the row is still `sending`
     * **under the lease this process was given**: a process that comes back after its lease ran out cannot overwrite
     * the result of the one that took the row over, neither when that one finished nor while it is still sending
     * (it holds a newer lease). True when this call wrote it.
     */
    async recordOutcome(notificationId: number, lease: string, outcome: NotificationOutcome): Promise<boolean> {
        const [rows]: [unknown[], number] = await this.dataSource.query(
            `UPDATE customer_notifications
                SET status = $2::varchar,
                    attempts = attempts + $3::int,
                    next_attempt_at = $4::timestamptz,
                    locked_until = NULL,
                    last_error = CASE WHEN $2::varchar = 'sent' THEN last_error ELSE $5::varchar END,
                    sent_at = CASE WHEN $2::varchar = 'sent' THEN NOW() ELSE sent_at END
              WHERE customer_notification_id = $1 AND status = 'sending' AND locked_until = $6::timestamptz
              RETURNING customer_notification_id`,
            [notificationId, outcome.status, outcome.attemptsMade, outcome.nextAttemptAt, outcome.lastError, lease],
        );
        return rows.length > 0;
    }
}
