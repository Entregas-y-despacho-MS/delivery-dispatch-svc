import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { INCIDENT_REPORTED_EVENT } from '../dispatch-incidents/domain/incident-report.js';
import { DISPATCH_STATUS_CHANGED_EVENT, type DispatchStatusChangedEvent } from '../dispatch-status/dispatch-status-changed.event.js';
import { CustomerStatusNoticeService } from './services/customer-status-notice.service.js';

/** Only the error class: its message could carry query parameters. */
const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'unknown');

/** Sends the customer the email of a status change after it committed; it never fails the transition. */
@Injectable()
export class CustomerStatusNoticeListener {
    private readonly logger = new Logger(CustomerStatusNoticeListener.name);

    constructor(private readonly notices: CustomerStatusNoticeService) {}

    @OnEvent(DISPATCH_STATUS_CHANGED_EVENT, { async: true })
    async handle(event: DispatchStatusChangedEvent): Promise<void> {
        try {
            await this.notices.handle(event);
        } catch (error) {
            this.logger.error({ event: 'status_notice_failed', dispatchId: event.dispatchId, status: event.status, error: errorName(error) });
        }
    }

    /** The driver's incident report (order in `incident`) does not emit `dispatch.status_changed`. */
    @OnEvent(INCIDENT_REPORTED_EVENT, { async: true })
    async handleIncident(event: { dispatchId: number; reportedAt: string }): Promise<void> {
        try {
            await this.notices.handleIncident(event);
        } catch (error) {
            this.logger.error({ event: 'status_notice_failed', dispatchId: event.dispatchId, status: 'incident', error: errorName(error) });
        }
    }
}
