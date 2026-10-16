import { Injectable, OnModuleInit } from '@nestjs/common';
import { ScheduledTaskRegistry } from '../scheduler/services/scheduled-task-registry.service.js';
import { RouteReminderService } from './services/route-reminder.service.js';

/** Name of the task of `route_reminder_time` (also its lock key). Not exposed by a manual endpoint. */
export const ROUTE_REMINDER_TASK = 'route-reminder';

/** Registers the customer reminder of the next route day at `route_reminder_time` (ST-51.4 / D-46). */
@Injectable()
export class RouteReminderTask implements OnModuleInit {
    constructor(
        private readonly registry: ScheduledTaskRegistry,
        private readonly reminder: RouteReminderService,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: ROUTE_REMINDER_TASK,
            schedule: { kind: 'time', settingKey: 'route_reminder_time' },
            run: async (context) => await this.reminder.run(context),
        });
    }
}
