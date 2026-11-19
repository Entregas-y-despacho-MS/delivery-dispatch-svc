import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailerPort } from '../../../plugins/mailer/mailer.port.js';
import { buildStatusNotice, eligibleStatusNotice, formatOccurredAt, trackingLink, type StatusTransition } from '../domain/build-status-notice.js';
import { STATUS_NOTICE_DISPATCH_TYPE, STATUS_NOTICE_TEMPLATE } from '../domain/status-notice-table.js';
import { CustomerStatusNoticeRepository } from './customer-status-notice.repository.js';

export type StatusNoticeOutcome = 'sent' | 'bounced' | 'failed' | 'ignored' | 'no-recipient' | 'duplicate';

/**
 * The email owed to the customer when a delivery changes status (ST-39.1, RF-U16). Which transitions count is
 * the table in `status-notice-table.ts`. The email is reserved in `dispatch_events` before it is sent, so a
 * repeated event does not send it twice. Logs carry the dispatch id and the status only: never the address,
 * the phone or the tracking token.
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

    async handle(event: StatusTransition, now: Date = new Date()): Promise<StatusNoticeOutcome> {
        if (!eligibleStatusNotice(event)) return 'ignored';
        const dispatch = await this.repository.findDispatch(event.dispatchId);
        if (!dispatch || dispatch.type !== STATUS_NOTICE_DISPATCH_TYPE) return 'ignored';
        const notice = buildStatusNotice(event, dispatch);
        if (!notice) {
            this.logger.warn({ event: 'status_notice_skipped', dispatchId: event.dispatchId, status: event.status });
            return 'no-recipient';
        }
        if (!(await this.repository.reserve(notice.dispatchId, notice.status, notice.occurredAt))) return 'duplicate';

        let result: 'sent' | 'bounced' | 'failed' = 'failed';
        try {
            const delivery = await this.mailer.send({
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
                metadata: { dispatchId: notice.dispatchId, template: STATUS_NOTICE_TEMPLATE, status: notice.status },
            });
            result = delivery.status;
        } catch {
            this.logger.warn({ event: 'status_notice_send_failed', dispatchId: notice.dispatchId, status: notice.status });
        }
        try {
            await this.repository.recordResult(notice.dispatchId, notice.status, notice.occurredAt, result);
        } catch {
            this.logger.error({ event: 'status_notice_result_not_recorded', dispatchId: notice.dispatchId, status: notice.status, result });
        }
        return result;
    }
}
