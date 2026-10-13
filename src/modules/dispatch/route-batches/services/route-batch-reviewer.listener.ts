import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RouteBatchReviewerService } from './route-batch-reviewer.service.js';
import { USER_ELIGIBILITY_CHANGED_EVENT } from '../../../auth/users/events/user-eligibility-changed.event.js';
import type { UserEligibilityChangedEvent } from '../../../auth/users/events/user-eligibility-changed.event.js';

/**
 * ST-50.4 — when a user is deactivated, deleted or changes role, the batches they were reviewing are handed
 * over, whole, by balance (D-42). The event is only a nudge: the service re-reads who is still eligible.
 */
@Injectable()
export class RouteBatchReviewerListener {
    private readonly logger = new Logger(RouteBatchReviewerListener.name);

    constructor(private readonly reviewers: RouteBatchReviewerService) {}

    @OnEvent(USER_ELIGIBILITY_CHANGED_EVENT, { async: true })
    async onUserEligibilityChanged(event: UserEligibilityChangedEvent): Promise<void> {
        try {
            await this.reviewers.reassignFromIneligibleReviewers(`user_${event.reason}`);
        } catch (error) {
            // The user change is already committed; the idempotent sweep can be run again later.
            this.logger.error(`Could not reassign the batches of user ${event.userId} (${event.reason}): ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
