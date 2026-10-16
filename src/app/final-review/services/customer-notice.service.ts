import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailerPort } from '../../../plugins/mailer/mailer.port.js';
import { customerNoticeAction, type FinalReviewSettings } from '../domain/final-review-timeline.js';
import { formatNoticeDate, formatNoticeWindow } from '../domain/notice-format.js';
import { DELIVERY_MAINTAINED_SENT_EVENT, ROUTE_REMINDER_SENT_EVENT } from '../final-review-events.js';
import { FinalReviewRepository, type NoticeDispatchRow } from './final-review.repository.js';

export interface CustomerNoticeSummary {
    reminders: number;
    maintained: number;
    /** Not sent and not claimed: no email or no tracking link yet. */
    skipped: number;
    /** Before `route_reminder_time`: the 16:30 task will send it. */
    waiting: number;
    /** The mail transport bounced or failed; a coordinator follow-up was opened. */
    failed: number;
}

const TEMPLATES = {
    'send-reminder': { template: 'reminder', subject: 'Recordatorio de tu entrega', event: ROUTE_REMINDER_SENT_EVENT },
    'send-delivery-maintained': { template: 'delivery-maintained', subject: 'Tu entrega se mantiene', event: DELIVERY_MAINTAINED_SENT_EVENT },
} as const;

/**
 * The emails the customers of a `confirmed` batch are owed (ST-51.4, D-46): the normal reminder or, when
 * a risk notice already went out, «tu entrega se mantiene». One rule for the 16:30 task and for the late
 * approval (`customerNoticeAction`), so each customer gets each email once.
 *
 * The event is written **before** sending, in one statement that refuses a second one: two callers at
 * the same minute (the task and a late approval) cannot both send. A bounce or failure is not retried by
 * this code: it opens a coordinator follow-up (`contact_management_required`), like a bounced promise.
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
        const summary: CustomerNoticeSummary = { reminders: 0, maintained: 0, skipped: 0, waiting: 0, failed: 0 };
        for (const dispatch of await this.repository.findNoticeDispatches(routeBatchId)) {
            const action = customerNoticeAction(now, shiftDate, settings, {
                reminderSent: dispatch.reminderSent,
                riskNoticeSent: dispatch.riskNoticeSent,
                maintainedSent: dispatch.maintainedSent,
            });
            if (action === 'wait') { summary.waiting += 1; continue; }
            if (action === 'none') continue;
            if (!dispatch.contactEmail || !dispatch.trackingToken) { summary.skipped += 1; continue; }

            const outcome = await this.send(routeBatchId, dispatch, action);
            if (outcome === 'sent') {
                if (action === 'send-reminder') summary.reminders += 1; else summary.maintained += 1;
            } else if (outcome === 'failed') {
                summary.failed += 1;
            }
        }
        return summary;
    }

    private async send(routeBatchId: number, dispatch: NoticeDispatchRow, action: keyof typeof TEMPLATES): Promise<'sent' | 'failed' | 'claimed-elsewhere'> {
        const { template, subject, event } = TEMPLATES[action];
        const claimed = await this.repository.claimDispatchEvent(dispatch.dispatchId, event, `${subject}: email handed to the mail transport`, { routeBatchId, template });
        if (!claimed) return 'claimed-elsewhere';

        let result: 'sent' | 'bounced' | 'failed' = 'failed';
        try {
            const delivery = await this.mailer.send({
                to: dispatch.contactEmail!,
                subject,
                template,
                context: {
                    deliveryDate: formatNoticeDate(dispatch.windowStart),
                    deliveryWindow: formatNoticeWindow(dispatch.windowStart, dispatch.windowEnd),
                    trackingUrl: `${this.webUrl}/seguimiento/${dispatch.trackingToken}`,
                },
                metadata: { dispatchId: dispatch.dispatchId, routeBatchId, template },
            });
            result = delivery.status;
        } catch (error) {
            this.logger.warn(`Email "${template}" for dispatch ${dispatch.dispatchId} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (result === 'sent') return 'sent';

        await this.repository.recordContactManagement(routeBatchId, dispatch.dispatchId, `${subject}: email ${result}; coordinator must contact the customer`, {
            category: 'customer_contact', template, deliveryResult: result,
        });
        return 'failed';
    }
}
