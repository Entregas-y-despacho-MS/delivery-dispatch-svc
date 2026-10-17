import { Injectable, OnModuleInit } from '@nestjs/common';
import { ScheduledTaskRegistry } from '../scheduler/services/scheduled-task-registry.service.js';
import { FinalReviewEscalationService } from './services/final-review-escalation.service.js';

/** Name of the task of `final_review_escalation_time` (also its lock key). Not exposed by a manual endpoint. */
export const FINAL_REVIEW_ESCALATION_TASK = 'final-review-escalation';

/** Registers the escalation of a 2nd approval still pending on the route day (ST-51.4 / D-46). */
@Injectable()
export class FinalReviewEscalationTask implements OnModuleInit {
    constructor(
        private readonly registry: ScheduledTaskRegistry,
        private readonly escalation: FinalReviewEscalationService,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: FINAL_REVIEW_ESCALATION_TASK,
            schedule: { kind: 'time', settingKey: 'final_review_escalation_time' },
            run: async (context) => await this.escalation.run(context),
        });
    }
}
