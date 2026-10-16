import { Module } from '@nestjs/common';
import { PlanningModule } from '../planning/planning.module.js';
import { FinalReviewAlertTask } from './final-review-alert.task.js';
import { FinalReviewAlertService } from './services/final-review-alert.service.js';
import { FinalReviewRepository } from './services/final-review.repository.js';

/**
 * The 2nd approval out of time (ST-51.4, D-46): alert, reminder and escalation. SettingsService, the
 * scheduler registry and the mailer are global; the tasks register themselves in `onModuleInit`.
 * `PlanningModule` provides the alerts.
 */
@Module({
    imports: [PlanningModule],
    providers: [FinalReviewRepository, FinalReviewAlertService, FinalReviewAlertTask],
})
export class FinalReviewModule {}
