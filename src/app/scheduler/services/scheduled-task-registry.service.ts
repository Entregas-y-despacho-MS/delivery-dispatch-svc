import { Injectable } from '@nestjs/common';
import { ScheduledTaskAlreadyRegisteredException } from '../exceptions/index.js';
import type { ScheduledTask } from '../ports/scheduled-task.js';

/**
 * Where features plug their scheduled tasks in (ST-50.3). The module is global, so a feature only
 * injects this and calls `register` from `onModuleInit`; it never touches the scheduler itself:
 *
 *   onModuleInit() {
 *       this.registry.register({
 *           name: 'plan-generation',
 *           schedule: { kind: 'times', settingKey: 'plan_generation_times' },
 *           run: async (context) => { ... },
 *       });
 *   }
 */
@Injectable()
export class ScheduledTaskRegistry {
    private readonly tasks = new Map<string, ScheduledTask>();

    register(task: ScheduledTask): void {
        if (this.tasks.has(task.name)) throw new ScheduledTaskAlreadyRegisteredException(task.name);
        this.tasks.set(task.name, task);
    }

    get(name: string): ScheduledTask | undefined {
        return this.tasks.get(name);
    }

    list(): ScheduledTask[] {
        return [...this.tasks.values()];
    }
}
