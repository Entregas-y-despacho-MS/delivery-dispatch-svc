import { Injectable, OnModuleInit } from '@nestjs/common';
import { ScheduledTaskRegistry } from '../scheduler/services/scheduled-task-registry.service.js';
import { NoticeReconciliationService } from './services/notice-reconciliation.service.js';

/** Name of the reconciliation task (also its lock key). Not exposed by a manual endpoint. */
export const NOTICE_RECONCILIATION_TASK = 'notice-reconciliation';

/** How often it runs. The abandoned lease is 15 minutes, so a stuck email is closed within about 20. */
export const NOTICE_RECONCILIATION_EVERY_MINUTES = 5;

/** Registers the safety net of the customer emails: abandoned reservations and notices still owed (ST-51.4). */
@Injectable()
export class NoticeReconciliationTask implements OnModuleInit {
    constructor(
        private readonly registry: ScheduledTaskRegistry,
        private readonly reconciliation: NoticeReconciliationService,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: NOTICE_RECONCILIATION_TASK,
            schedule: { kind: 'every-minutes', minutes: NOTICE_RECONCILIATION_EVERY_MINUTES },
            run: async (context) => await this.reconciliation.run(context),
        });
    }
}
