import { Injectable, OnModuleInit } from '@nestjs/common';
import { PLAN_GENERATION_TASK } from '../scheduler/scheduled-task-names.js';
import { ScheduledTaskRegistry } from '../scheduler/services/scheduled-task-registry.service.js';
import { PlanGenerationService } from './services/plan-generation.service.js';

/**
 * Registers the batch generator in the scheduler (ST-50.3 / D-40). It runs at the times of the
 * setting `plan_generation_times` and, by hand, from `POST /planning/generate`, under the same lock.
 */
@Injectable()
export class PlanGenerationTask implements OnModuleInit {
    constructor(
        private readonly registry: ScheduledTaskRegistry,
        private readonly generation: PlanGenerationService,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: PLAN_GENERATION_TASK,
            schedule: { kind: 'times', settingKey: 'plan_generation_times' },
            run: async (context) => await this.generation.run(context),
        });
    }
}
