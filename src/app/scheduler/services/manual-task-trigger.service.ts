import { Injectable } from '@nestjs/common';
import { TaskRunResultDto } from '../dto/task-run-result.dto.js';
import {
    ScheduledTaskAlreadyRunningException,
    ScheduledTaskFailedException,
    ScheduledTaskNotAvailableException,
} from '../exceptions/index.js';
import { ScheduledTaskRegistry } from './scheduled-task-registry.service.js';
import { ScheduledTaskRunner } from './scheduled-task-runner.service.js';

/**
 * Fires a registered task right now, for demos and for the coordinator who cannot wait for the
 * clock. It goes through the same runner as the schedule, so it takes the same lock: it can never
 * overlap a scheduled run, on this or any other instance. It is not deduplicated (no occurrence).
 * It works even when `SCHEDULER_ENABLED=false`, because it does not depend on the minute tick.
 */
@Injectable()
export class ManualTaskTriggerService {
    constructor(
        private readonly registry: ScheduledTaskRegistry,
        private readonly runner: ScheduledTaskRunner,
    ) {}

    async trigger(taskName: string): Promise<TaskRunResultDto> {
        const task = this.registry.get(taskName);
        if (!task) throw new ScheduledTaskNotAvailableException();

        const outcome = await this.runner.run(task, { trigger: 'manual', occurrence: null });

        if (outcome.status === 'skipped-locked') throw new ScheduledTaskAlreadyRunningException();
        if (outcome.status === 'failed') throw new ScheduledTaskFailedException();

        return { task: taskName, status: 'executed', finishedAt: new Date() };
    }
}
