import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailerPort } from '../../../plugins/mailer/mailer.port.js';
import { customerNoticeAction, type FinalReviewSettings } from '../domain/final-review-timeline.js';
import { formatNoticeDate, formatNoticeWindow } from '../domain/notice-format.js';
import {
    DELIVERY_MAINTAINED_SENT_EVENT,
    RISK_NOTICE_FAILED_EVENT,
    RISK_NOTICE_SENT_EVENT,
    ROUTE_REMINDER_SENT_EVENT,
} from '../final-review-events.js';
import { FinalReviewRepository, type DispatchNoticeState } from './final-review.repository.js';

export interface CustomerNoticeSummary {
    reminders: number;
    maintained: number;
    /** Not sent: no email (or no tracking link) — a coordinator follow-up was opened. */
    skipped: number;
    /** Before `route_reminder_time`: the 16:30 task will send it. */
    waiting: number;
    /** The mail transport bounced or failed; a coordinator follow-up was opened. */
    failed: number;
    /** Orders whose database step failed; the rest of the batch went on. */
    errors: number;
}

export type NoticeAction = 'send-reminder' | 'send-delivery-maintained' | 'send-risk-notice';

export const NOTICE_TEMPLATES: Record<NoticeAction, { template: string; subject: string; event: string }> = {
    'send-reminder': { template: 'reminder', subject: 'Recordatorio de tu entrega', event: ROUTE_REMINDER_SENT_EVENT },
    'send-delivery-maintained': { template: 'delivery-maintained', subject: 'Tu entrega se mantiene', event: DELIVERY_MAINTAINED_SENT_EVENT },
    'send-risk-notice': { template: 'risk-notice', subject: 'Estamos gestionando tu entrega', event: RISK_NOTICE_SENT_EVENT },
};

type Claim = { kind: 'none' | 'wait' | 'skipped' } | { kind: 'send'; action: NoticeAction; state: DispatchNoticeState };

export const emptyNoticeSummary = (): CustomerNoticeSummary => ({ reminders: 0, maintained: 0, skipped: 0, waiting: 0, failed: 0, errors: 0 });

/**
 * The emails the customers of a `confirmed` batch are owed (ST-51.4, D-46): the normal reminder or, when
 * a risk notice already went out, «tu entrega se mantiene». One rule for the 16:30 task and for the late
 * approval (`customerNoticeAction`), so each customer gets each email once per batch.
 *
 * Deciding and reserving happen together, under the lock of the batch (`inBatchLock`): the state is read
 * and the event is written while nobody can approve or escalate it, so the task and a late approval in the
 * same minute cannot both send. The email goes out after the lock is released. A bounce or failure is not
 * retried: it opens a coordinator follow-up (`contact_management_required`).
 */
@Injectable()
export class CustomerNoticeService {
    private readonly logger = new Logger(CustomerNoticeService.name);
    private readonly webUrl: string;

    constructor(
        private readonly repository: FinalReviewRepository,
        private readonly mailer: MailerPort,
        config: ConfigService,
    ) {
        this.webUrl = config.get<string>('PUBLIC_WEB_URL', 'http://localhost:5173')!.replace(/\/$/, '');
    }

    async sendDueNotices(routeBatchId: number, shiftDate: string, now: Date, settings: FinalReviewSettings): Promise<CustomerNoticeSummary> {
        const summary = emptyNoticeSummary();
        for (const dispatchId of await this.repository.findDispatchIds(routeBatchId, 'assigned', false)) {
            try {
                const claim = await this.claimDue(routeBatchId, dispatchId, shiftDate, now, settings);
                if (claim.kind === 'wait') summary.waiting += 1;
                else if (claim.kind === 'skipped') summary.skipped += 1;
                else if (claim.kind === 'send') {
                    const outcome = await this.deliver(routeBatchId, claim.state, claim.action);
                    if (outcome === 'failed') summary.failed += 1;
                    else if (claim.action === 'send-reminder') summary.reminders += 1;
                    else summary.maintained += 1;
                }
            } catch (error) {
                summary.errors += 1;
                this.logger.error(`Notice for dispatch ${dispatchId} of batch ${routeBatchId} failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return summary;
    }

    private async claimDue(routeBatchId: number, dispatchId: number, shiftDate: string, now: Date, settings: FinalReviewSettings): Promise<Claim> {
        const claim = await this.repository.inBatchLock<Claim>(routeBatchId, async (scope) => {
            if (scope.status !== 'confirmed') return { kind: 'none' };
            const state = await scope.dispatchState(dispatchId);
            if (!state || state.status !== 'assigned') return { kind: 'none' };

            const decision = customerNoticeAction(now, shiftDate, settings, {
                reminderSent: state.reminderSent,
                riskNoticeSent: state.riskNoticeSent,
                maintainedSent: state.maintainedSent,
            });
            if (decision === 'wait') return { kind: 'wait' };
            if (decision === 'none') return { kind: 'none' };

            const action: NoticeAction = decision;
            const { template, subject, event } = NOTICE_TEMPLATES[action];
            if (!state.contactEmail || !state.trackingToken) {
                await scope.recordContactManagementOnce(dispatchId, template, `${subject}: the order has no email or tracking link; coordinator must contact the customer`, {
                    category: 'customer_contact', deliveryResult: 'no_contact',
                });
                return { kind: 'skipped' };
            }
            const claimed = await scope.claimDispatchEvent(dispatchId, event, `${subject}: email handed to the mail transport`, { template });
            return claimed ? { kind: 'send', action, state } : { kind: 'none' };
        });
        return claim ?? { kind: 'none' };
    }

    /**
     * Sends an email whose event was already reserved. On a bounce or failure it opens the coordinator
     * follow-up (and, for the risk notice, records that the customer was not warned); that bookkeeping
     * never throws, so one bad order cannot stop the rest.
     */
    async deliver(routeBatchId: number, state: DispatchNoticeState, action: NoticeAction): Promise<'sent' | 'failed'> {
        const { template, subject } = NOTICE_TEMPLATES[action];
        let result: 'sent' | 'bounced' | 'failed' = 'failed';
        try {
            const delivery = await this.mailer.send({
                to: state.contactEmail!,
                subject,
                template,
                context: {
                    deliveryDate: formatNoticeDate(state.windowStart),
                    deliveryWindow: formatNoticeWindow(state.windowStart, state.windowEnd),
                    trackingUrl: state.trackingToken ? `${this.webUrl}/seguimiento/${state.trackingToken}` : '',
                },
                metadata: { dispatchId: state.dispatchId, routeBatchId, template },
            });
            result = delivery.status;
        } catch (error) {
            this.logger.warn(`Email "${template}" for dispatch ${state.dispatchId} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (result === 'sent') return 'sent';

        try {
            await this.repository.recordSendFailure(
                routeBatchId, state.dispatchId, template, result,
                `${subject}: email ${result}; coordinator must contact the customer`,
                action === 'send-risk-notice' ? RISK_NOTICE_FAILED_EVENT : undefined,
            );
        } catch (error) {
            this.logger.error(`Could not record the ${result} "${template}" of dispatch ${state.dispatchId}: ${error instanceof Error ? error.message : String(error)}`);
        }
        return 'failed';
    }
}
