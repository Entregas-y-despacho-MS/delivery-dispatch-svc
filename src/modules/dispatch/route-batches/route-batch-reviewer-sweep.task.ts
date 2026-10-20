import { Injectable, OnModuleInit } from '@nestjs/common';
import { ScheduledTaskRegistry } from '../../../app/scheduler/services/scheduled-task-registry.service.js';
import { RouteBatchReviewerService } from './services/route-batch-reviewer.service.js';

/** Name of the sweep (also its lock key). Not exposed by a manual endpoint. */
export const REVIEWER_SWEEP_TASK = 'route-batch-reviewer-sweep';

/** How often it runs. The listener already hands over the batches when a user changes; this only catches what it missed. */
export const REVIEWER_SWEEP_EVERY_MINUTES = 15;

/**
 * Safety net of D-42 (ST-50.4): hands over the provisional batches whose reviewer is no longer an active coordinator
 * or supervisor. The user-change listener covers the normal case; this covers a change made inside an outer
 * transaction (the event is emitted before it commits) or a listener that failed. Idempotent: it re-reads who is
 * eligible, so a run with nothing to do writes nothing.
 */
@Injectable()
export class RouteBatchReviewerSweepTask implements OnModuleInit {
    constructor(
        private readonly registry: ScheduledTaskRegistry,
        private readonly reviewers: RouteBatchReviewerService,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: REVIEWER_SWEEP_TASK,
            schedule: { kind: 'every-minutes', minutes: REVIEWER_SWEEP_EVERY_MINUTES },
            run: async () => {
                const handedOver = await this.reviewers.reassignFromIneligibleReviewers('scheduled_sweep');
                return { handedOver: handedOver.length };
            },
        });
    }
}
