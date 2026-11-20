import { Injectable, OnModuleInit } from '@nestjs/common';
import { ScheduledTaskRegistry } from '../scheduler/services/scheduled-task-registry.service.js';
import { CustomerStatusNoticeService } from './services/customer-status-notice.service.js';

/** Name of the recovery task (also its cluster lock key). Not exposed by a manual endpoint. */
export const CUSTOMER_NOTIFICATION_RECOVERY_TASK = 'customer-notification-recovery';

/** How often it runs. The attempt lease is 10 minutes, so an email left behind by a dead process is retaken within about 15. */
export const CUSTOMER_NOTIFICATION_RECOVERY_EVERY_MINUTES = 5;

/**
 * Registers the safety net of the status change emails (ST-39.2): the ones the provider could not take and the ones a
 * dead process left unfinished are tried again, with the recipient and status they were registered with.
 */
@Injectable()
export class CustomerNotificationRecoveryTask implements OnModuleInit {
    constructor(
        private readonly registry: ScheduledTaskRegistry,
        private readonly notices: CustomerStatusNoticeService,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: CUSTOMER_NOTIFICATION_RECOVERY_TASK,
            schedule: { kind: 'every-minutes', minutes: CUSTOMER_NOTIFICATION_RECOVERY_EVERY_MINUTES },
            run: async (context) => await this.notices.recoverDue(context.startedAt),
        });
    }
}
