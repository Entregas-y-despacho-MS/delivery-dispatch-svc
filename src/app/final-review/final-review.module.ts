import { Module } from '@nestjs/common';
import { PlanningModule } from '../planning/planning.module.js';
import { FinalReviewAlertTask } from './final-review-alert.task.js';
import { FinalReviewEscalationTask } from './final-review-escalation.task.js';
import { LateApprovalNoticeListener } from './late-approval-notice.listener.js';
import { NoticeReconciliationTask } from './notice-reconciliation.task.js';
import { RouteReminderTask } from './route-reminder.task.js';
import { CustomerNoticeService } from './services/customer-notice.service.js';
import { FinalReviewAlertService } from './services/final-review-alert.service.js';
import { FinalReviewEscalationService } from './services/final-review-escalation.service.js';
import { FinalReviewRepository } from './services/final-review.repository.js';
import { NoticeReconciliationService } from './services/notice-reconciliation.service.js';
import { RouteReminderService } from './services/route-reminder.service.js';

/**
 * The 2nd approval out of time (ST-51.4, D-46): alert, reminder and escalation. SettingsService, the
 * scheduler registry, the mailer and the event emitter are global; the tasks register themselves in
 * `onModuleInit`. `PlanningModule` provides the alerts.
 */
@Module({
    imports: [PlanningModule],
    providers: [
        FinalReviewRepository,
        CustomerNoticeService,
        FinalReviewAlertService,
        FinalReviewAlertTask,
        FinalReviewEscalationService,
        FinalReviewEscalationTask,
        RouteReminderService,
        RouteReminderTask,
        LateApprovalNoticeListener,
        NoticeReconciliationService,
        NoticeReconciliationTask,
    ],
})
export class FinalReviewModule {}
