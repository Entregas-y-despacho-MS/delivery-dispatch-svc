import { HttpException, Injectable } from '@nestjs/common';
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
        if (outcome.status === 'failed') {
            // A domain error the task chose to raise (422 settings missing, 503 OSRM down) reaches the
            // caller as it is; anything else is an unexpected failure.
            if (outcome.cause instanceof HttpException) throw outcome.cause;
            throw new ScheduledTaskFailedException();
        }

        const summary = outcome.status === 'executed' && outcome.result && typeof outcome.result === 'object'
            ? (outcome.result as Record<string, unknown>)
            : undefined;
        return { task: taskName, status: 'executed', finishedAt: new Date(), ...(summary ? { summary: summary as unknown as TaskRunResultDto['summary'] } : {}) };
    }
}
