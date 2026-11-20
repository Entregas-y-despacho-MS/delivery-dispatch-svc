import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailerPort, type MailDeliveryResult } from '../../../plugins/mailer/mailer.port.js';
import {
    buildStatusNotice, eligibleStatusNotice, formatOccurredAt, rebuildStatusNotice, trackingLink,
    type StatusNotice, type StatusNoticeDispatch, type StatusTransition,
} from '../domain/build-status-notice.js';
import { INLINE_MAX_ATTEMPTS, MAX_TOTAL_ATTEMPTS, classifyDelivery, inlineBackoffMs, nextStepAfterFailure } from '../domain/delivery-policy.js';
import { STATUS_CHANGE_NOTIFICATION, idempotencyKey, sourceEventKey } from '../domain/idempotency.js';
import { sanitizeError } from '../domain/sanitize-error.js';
import { STATUS_NOTICE_DISPATCH_TYPE, STATUS_NOTICE_TEMPLATE, STATUS_NOTICE_TEMPLATE_VERSION } from '../domain/status-notice-table.js';
import { CustomerStatusNoticeRepository, type ClaimedNotification, type NotificationOutcome } from './customer-status-notice.repository.js';

/** `failed` is a transient failure: the email stays registered as `retrying` (or `exhausted`) and the recovery task owns it. */
export type StatusNoticeOutcome = 'sent' | 'bounced' | 'failed' | 'ignored' | 'no-recipient' | 'duplicate';

const BOUNCE_ERROR = 'The mail provider rejected the recipient.';

/** Emails the recovery task takes over in one run; the rest wait for the next one. */
export const RECOVERY_BATCH_SIZE = 50;

/** What one run of the recovery task did. `failed` stays `retrying` (or becomes `exhausted` on the last attempt). */
export interface RecoverySummary {
    claimed: number;
    sent: number;
    bounced: number;
    failed: number;
    exhausted: number;
    /** Rows whose own processing threw; the lease runs out and the next run takes them again. */
    errors: number;
}

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * The email owed to the customer when a delivery changes status (ST-39.1, RF-U16), sent once and recoverable (ST-39.2).
 *
 * The email is registered in `customer_notifications` before it is sent, under an idempotency key made of the source
 * event and the type of notification: a repeated or concurrent delivery of the same event finds the key taken and
 * sends nothing. The send is attempted up to three times right away (the push retry policy); a transient failure
 * (`failed`) that survives them stays `retrying` for the recovery task, and a permanent one (`bounced`) is not retried.
 * Nothing here ever fails the status transition that originated the email: it runs after the commit and its errors
 * are recorded, not thrown. Logs carry the dispatch id and the status only: never the address, the phone, the
 * tracking token or the provider's error.
 */
@Injectable()
export class CustomerStatusNoticeService {
    private readonly logger = new Logger(CustomerStatusNoticeService.name);
    private readonly webUrl: string;

    constructor(
        private readonly repository: CustomerStatusNoticeRepository,
        private readonly mailer: MailerPort,
        config: ConfigService,
    ) {
        this.webUrl = config.get<string>('PUBLIC_WEB_URL', 'http://localhost:5173')!.replace(/\/$/, '');
    }

    /**
     * The driver's incident report moves the order to `incident` but announces it with `dispatch.incident_reported`,
     * not with `dispatch.status_changed`, so it is mapped here to the same transition. Other emitters of that event
     * (the warehouse receipt) do not leave the order in `incident`: those are ignored.
     */
    async handleIncident(incident: { dispatchId: number; reportedAt: string }): Promise<StatusNoticeOutcome> {
        const dispatch = await this.repository.findDispatch(incident.dispatchId);
        if (!dispatch || dispatch.currentStatus !== 'incident') return 'ignored';
        return await this.handle({
            dispatchId: incident.dispatchId, status: 'incident', previousStatus: null, updatedAt: incident.reportedAt,
        });
    }

    async handle(event: StatusTransition, now: Date = new Date(), wait: (milliseconds: number) => Promise<void> = delay): Promise<StatusNoticeOutcome> {
        if (!eligibleStatusNotice(event)) return 'ignored';
        const dispatch = await this.repository.findDispatch(event.dispatchId);
        if (!dispatch || dispatch.type !== STATUS_NOTICE_DISPATCH_TYPE) return 'ignored';
        const notice = buildStatusNotice(event, dispatch);
        if (!notice) {
            this.logger.warn({ event: 'status_notice_skipped', dispatchId: event.dispatchId, status: event.status });
            return 'no-recipient';
        }

        const source = sourceEventKey(notice.dispatchId, notice.status, notice.occurredAt);
        const reserved = await this.repository.reserve({
            dispatchId: notice.dispatchId,
            notificationType: STATUS_CHANGE_NOTIFICATION,
            idempotencyKey: idempotencyKey(STATUS_CHANGE_NOTIFICATION, source),
            sourceEventKey: source,
            dispatchStatus: notice.status,
            occurredAt: notice.occurredAt,
            recipient: notice.recipient,
            template: STATUS_NOTICE_TEMPLATE,
            templateVersion: STATUS_NOTICE_TEMPLATE_VERSION,
        });
        if (!reserved) return 'duplicate';

        return await this.attempt(reserved, notice, dispatch, { attemptsBefore: 0, maxAttempts: INLINE_MAX_ATTEMPTS, now, wait });
    }

    /**
     * The safety net (run by the recovery task): takes over the emails that are due — `retrying` with their next
     * attempt reached, `sending` with a lease that ran out — and gives each one a single attempt, with the same
     * recipient and status it was registered with. An email that used up its attempts, or whose status is no
     * longer notifiable, is closed as `exhausted` without sending. One bad row never stops the rest.
     *
     * The rows are taken **one at a time**, each right before it is sent: a batch taken at once would start every
     * lease together, and with a slow provider the last rows of the batch would see theirs run out while they wait
     * their turn (and the next run would take them again and send them twice). `now` is for tests; a real run reads
     * the clock for each row.
     */
    async recoverDue(now?: Date, limit: number = RECOVERY_BATCH_SIZE): Promise<RecoverySummary> {
        const summary: RecoverySummary = { claimed: 0, sent: 0, bounced: 0, failed: 0, exhausted: 0, errors: 0 };
        for (let taken = 0; taken < limit; taken += 1) {
            const [row] = await this.repository.claimDue(1);
            if (!row) break;
            summary.claimed += 1;
            try {
                const outcome = await this.recoverOne(row, now ?? new Date());
                summary[outcome] += 1;
            } catch {
                summary.errors += 1;
                this.logger.error({ event: 'status_notice_recovery_failed', dispatchId: row.dispatchId, status: row.dispatchStatus });
            }
        }
        return summary;
    }

    private async recoverOne(row: ClaimedNotification, now: Date): Promise<'sent' | 'bounced' | 'failed' | 'exhausted'> {
        const dispatch = await this.repository.findDispatch(row.dispatchId);
        const notice = dispatch ? rebuildStatusNotice(row, dispatch) : null;
        if (!dispatch || !notice) return await this.close(row, 'The status of this email can no longer be notified.');
        if (row.attempts >= MAX_TOTAL_ATTEMPTS) return await this.close(row, 'The attempts of this email ran out.');
        const outcome = await this.attempt(row, notice, dispatch, { attemptsBefore: row.attempts, maxAttempts: 1, now, wait: delay });
        if (outcome === 'sent' || outcome === 'bounced') return outcome;
        return 'failed';
    }

    /** Ends an email that cannot or must not be sent again. */
    private async close(row: ClaimedNotification, reason: string): Promise<'exhausted'> {
        await this.repository.recordOutcome(row.notificationId, row.lease, { status: 'exhausted', attemptsMade: 0, nextAttemptAt: null, lastError: sanitizeError(reason) });
        this.logger.warn({ event: 'status_notice_exhausted', dispatchId: row.dispatchId, status: row.dispatchStatus });
        return 'exhausted';
    }

    /**
     * Sends a registered email, at most `maxAttempts` times in a row, and records how it ended. A transient failure
     * waits the inline backoff before the next attempt. The bookkeeping never throws: if the outcome cannot be
     * written the row keeps its lease and the recovery task retries it when the lease runs out.
     */
    private async attempt(
        owned: { notificationId: number; lease: string },
        notice: StatusNotice,
        dispatch: StatusNoticeDispatch,
        run: { attemptsBefore: number; maxAttempts: number; now: Date; wait: (milliseconds: number) => Promise<void> },
    ): Promise<StatusNoticeOutcome> {
        let result: MailDeliveryResult = { status: 'failed' };
        let attemptsMade = 0;
        while (attemptsMade < run.maxAttempts) {
            result = await this.sendOnce(owned.notificationId, notice, dispatch, run.now);
            attemptsMade += 1;
            if (classifyDelivery(result.status) !== 'transient') break;
            this.logger.warn({ event: 'status_notice_send_failed', dispatchId: notice.dispatchId, status: notice.status, attempt: run.attemptsBefore + attemptsMade });
            if (attemptsMade < run.maxAttempts) await run.wait(inlineBackoffMs(attemptsMade));
        }

        const outcome = this.outcomeOf(result, run.attemptsBefore, attemptsMade, run.now);
        try {
            if (!(await this.repository.recordOutcome(owned.notificationId, owned.lease, outcome))) {
                this.logger.warn({ event: 'status_notice_outcome_superseded', dispatchId: notice.dispatchId, status: notice.status });
            }
        } catch {
            this.logger.error({ event: 'status_notice_outcome_not_recorded', dispatchId: notice.dispatchId, status: notice.status, outcome: outcome.status });
        }
        if (outcome.status === 'retrying' || outcome.status === 'exhausted') {
            this.logger.warn({ event: `status_notice_${outcome.status}`, dispatchId: notice.dispatchId, status: notice.status });
        }
        return outcome.status === 'sent' ? 'sent' : outcome.status === 'bounced' ? 'bounced' : 'failed';
    }

    private outcomeOf(result: MailDeliveryResult, attemptsBefore: number, attemptsMade: number, now: Date): NotificationOutcome {
        const delivery = classifyDelivery(result.status);
        if (delivery === 'sent') return { status: 'sent', attemptsMade, nextAttemptAt: null, lastError: null };
        if (delivery === 'permanent') return { status: 'bounced', attemptsMade, nextAttemptAt: null, lastError: sanitizeError(result.error ?? BOUNCE_ERROR) };
        const next = nextStepAfterFailure(attemptsBefore + attemptsMade, now);
        return { status: next.status, attemptsMade, nextAttemptAt: next.nextAttemptAt, lastError: sanitizeError(result.error) };
    }

    /** One attempt with the provider. A thrown error is a transient failure like any other. */
    private async sendOnce(notificationId: number, notice: StatusNotice, dispatch: StatusNoticeDispatch, now: Date): Promise<MailDeliveryResult> {
        try {
            return await this.mailer.send({
                to: notice.recipient,
                subject: notice.subject,
                template: STATUS_NOTICE_TEMPLATE,
                context: {
                    statusLabel: notice.statusLabel,
                    message: notice.message,
                    occurredAt: formatOccurredAt(notice.occurredAt),
                    trackingCode: notice.trackingCode ?? '',
                    trackingUrl: trackingLink(dispatch, this.webUrl, now),
                },
                metadata: { dispatchId: notice.dispatchId, template: STATUS_NOTICE_TEMPLATE, status: notice.status, customerNotificationId: notificationId },
            });
        } catch (error) {
            return { status: 'failed', error: sanitizeError(error) };
        }
    }
}
