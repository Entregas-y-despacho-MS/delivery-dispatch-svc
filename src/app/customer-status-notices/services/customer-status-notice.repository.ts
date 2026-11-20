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
     * Registers the email and takes it for this process: the id of the new row, or `null` when the idempotency key is
     * already registered (a second delivery of the same event, or a concurrent copy of it). The unique index decides,
     * so no lock is needed. The row starts `sending` with a lease: if this process dies before it records the outcome,
     * the recovery task finds the row once the lease runs out.
     */
    async reserve(notification: NewNotification): Promise<number | null> {
        const rows: Array<{ customer_notification_id: number }> = await this.dataSource.query(
            `INSERT INTO customer_notifications
                    (dispatch_id, notification_type, idempotency_key, source_event_key, dispatch_status, occurred_at,
                     recipient, template, template_version, status, next_attempt_at, locked_until)
             VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, 'sending',
                     NOW() + make_interval(mins => $10::int), NOW() + make_interval(mins => $10::int))
             ON CONFLICT (idempotency_key) DO NOTHING
             RETURNING customer_notification_id`,
            [
                notification.dispatchId, notification.notificationType, notification.idempotencyKey, notification.sourceEventKey,
                notification.dispatchStatus, notification.occurredAt, notification.recipient, notification.template,
                notification.templateVersion, ATTEMPT_LEASE_MINUTES,
            ],
        );
        return rows[0]?.customer_notification_id ?? null;
    }

    /**
     * Writes how a round of attempts ended and releases the lease. It only touches a row that is still `sending`, so
     * a process that comes back after its lease ran out and another one took the row over cannot overwrite the result.
     * True when this call wrote it.
     */
    async recordOutcome(notificationId: number, outcome: NotificationOutcome): Promise<boolean> {
        const [rows]: [unknown[], number] = await this.dataSource.query(
            `UPDATE customer_notifications
                SET status = $2::varchar,
                    attempts = attempts + $3::int,
                    next_attempt_at = $4::timestamptz,
                    locked_until = NULL,
                    last_error = CASE WHEN $2::varchar = 'sent' THEN last_error ELSE $5::varchar END,
                    sent_at = CASE WHEN $2::varchar = 'sent' THEN NOW() ELSE sent_at END
              WHERE customer_notification_id = $1 AND status = 'sending'
              RETURNING customer_notification_id`,
            [notificationId, outcome.status, outcome.attemptsMade, outcome.nextAttemptAt, outcome.lastError],
        );
        return rows.length > 0;
    }
}
