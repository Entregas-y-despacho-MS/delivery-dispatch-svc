import { Injectable, OnModuleInit } from '@nestjs/common';
import { ROUTE_CUTOFF_TASK } from '../scheduler/scheduled-task-names.js';
import { ScheduledTaskRegistry } from '../scheduler/services/scheduled-task-registry.service.js';
import { RouteCutoffService } from './services/route-cutoff.service.js';

/**
 * Registers the D-1 cutoff in the scheduler (ST-50.3 / D-40). It runs at the time of the setting
 * `route_cutoff_time` and, by hand, from `POST /planning/cutoff`, under the same lock.
 */
@Injectable()
export class RouteCutoffTask implements OnModuleInit {
    constructor(
        private readonly registry: ScheduledTaskRegistry,
        private readonly cutoff: RouteCutoffService,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: ROUTE_CUTOFF_TASK,
            schedule: { kind: 'times', settingKey: 'route_cutoff_time' },
            run: async (context) => await this.cutoff.run(context),
        });
    }
}
