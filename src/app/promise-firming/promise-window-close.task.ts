import { Injectable, OnModuleInit } from '@nestjs/common';
import { ScheduledTaskRegistry } from '../scheduler/services/scheduled-task-registry.service.js';
import { PromiseWindowCloseService } from './services/promise-window-close.service.js';

/** Name of the task of the 12 h window (also its lock key). Not exposed by a manual endpoint. */
export const PROMISE_WINDOW_CLOSE_TASK = 'promise-window-close';

/** How often the window is checked. The setting that matters is `promise_response_window_minutes`. */
export const PROMISE_WINDOW_CLOSE_EVERY_MINUTES = 5;

/**
 * Registers the closing of the customer's response window in the scheduler (ST-50.3 / D-40).
 * Firmness lands within `PROMISE_WINDOW_CLOSE_EVERY_MINUTES` of the exact end of the window.
 */
@Injectable()
export class PromiseWindowCloseTask implements OnModuleInit {
    constructor(
        private readonly registry: ScheduledTaskRegistry,
        private readonly windowClose: PromiseWindowCloseService,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: PROMISE_WINDOW_CLOSE_TASK,
            schedule: { kind: 'every-minutes', minutes: PROMISE_WINDOW_CLOSE_EVERY_MINUTES },
            run: async (context) => await this.windowClose.run(context.startedAt),
        });
    }
}
