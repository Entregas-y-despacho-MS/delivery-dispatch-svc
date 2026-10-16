import { Injectable, OnModuleInit } from '@nestjs/common';
import { ScheduledTaskRegistry } from '../scheduler/services/scheduled-task-registry.service.js';
import { FinalReviewAlertService } from './services/final-review-alert.service.js';

/** Name of the task of `final_review_end_time` (also its lock key). Not exposed by a manual endpoint. */
export const FINAL_REVIEW_ALERT_TASK = 'final-review-alert';

/** Registers the alert of a 2nd approval that is still pending at `final_review_end_time` (ST-51.4 / D-46). */
@Injectable()
export class FinalReviewAlertTask implements OnModuleInit {
    constructor(
        private readonly registry: ScheduledTaskRegistry,
        private readonly alert: FinalReviewAlertService,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: FINAL_REVIEW_ALERT_TASK,
            schedule: { kind: 'time', settingKey: 'final_review_end_time' },
            run: async (context) => await this.alert.run(context),
        });
    }
}
