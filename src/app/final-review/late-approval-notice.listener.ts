import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SettingsService } from '../../modules/settings/services/settings.service.js';
import { ROUTE_ASSIGNED_EVENT, type RouteAssignedEvent } from '../../modules/dispatch/route-batches/events/route-assigned.event.js';
import { loadFinalReviewSettings } from './domain/final-review-timeline.js';
import { CustomerNoticeService } from './services/customer-notice.service.js';
import { FinalReviewRepository } from './services/final-review.repository.js';

/**
 * Late approval (ST-51.4, D-46): the 2nd approval of a batch that was not approved in time. Once the
 * batch is `confirmed`, the customers get what they are owed *at that moment*:
 * - after `route_reminder_time` and before any risk notice → the normal reminder;
 * - after the risk notice of the escalation → «tu entrega se mantiene»;
 * - before `route_reminder_time` → nothing: the 16:30 task will send it.
 * It runs after the approval has committed and never fails it: any error is only logged.
 */
@Injectable()
export class LateApprovalNoticeListener {
    private readonly logger = new Logger(LateApprovalNoticeListener.name);

    constructor(
        private readonly settings: SettingsService,
        private readonly repository: FinalReviewRepository,
        private readonly notices: CustomerNoticeService,
    ) {}

    @OnEvent(ROUTE_ASSIGNED_EVENT, { async: true })
    async handleRouteAssigned(event: RouteAssignedEvent, now: Date = new Date()): Promise<void> {
        try {
            const loaded = await loadFinalReviewSettings(this.settings);
            if (!loaded.ok) {
                this.logger.warn(`Late approval notices skipped for batch ${event.routeId}: settings missing or invalid.`);
                return;
            }
            const batch = await this.repository.findBatch(event.routeId);
            if (!batch || batch.status !== 'confirmed') return;
            await this.notices.sendDueNotices(batch.routeBatchId, batch.shiftDate, now, loaded.values!);
        } catch (error) {
            this.logger.error(`Late approval notices for batch ${event.routeId} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
