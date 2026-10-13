import { Injectable, Logger } from '@nestjs/common';
import type { ScheduledTask, TaskTrigger } from '../ports/scheduled-task.js';
import { TaskLock } from '../ports/task-lock.port.js';
import { TaskRunLog } from '../ports/task-run-log.port.js';

export type TaskRunOutcome =
    /** The task ran to the end on this instance. */
    | { status: 'executed' }
    /** Another instance is running it right now. */
    | { status: 'skipped-locked' }
    /** Another instance already ran this very occurrence (clock skew between instances). */
    | { status: 'skipped-already-ran' }
    /** The task threw. The lock was released and nothing was recorded, so the occurrence can be retried. */
    | { status: 'failed'; error: string };

export interface TaskRunRequest {
    trigger: TaskTrigger;
    /** `null` for a manual run: it is never deduplicated, only serialized by the lock. */
    occurrence: string | null;
}

/**
 * Runs one task under the cluster-wide lock. It never throws: every outcome is a value, so neither
 * the minute tick nor a request handler can be taken down by a task.
 *
 * Order inside the lock: (1) was this occurrence already recorded? (2) run, (3) record. The record
 * is written only after a successful run; a failed run leaves the occurrence open on purpose so that
 * another instance can retry it within the same minute.
 */
@Injectable()
export class ScheduledTaskRunner {
    private readonly logger = new Logger(ScheduledTaskRunner.name);

    constructor(
        private readonly lock: TaskLock,
        private readonly runLog: TaskRunLog,
    ) {}

    async run(task: ScheduledTask, request: TaskRunRequest): Promise<TaskRunOutcome> {
        try {
            const result = await this.lock.runExclusive<TaskRunOutcome>(task.name, async () => {
                if (request.occurrence !== null && (await this.runLog.wasRecorded(request.occurrence))) {
                    return { status: 'skipped-already-ran' };
                }

                const startedAt = new Date();
                await task.run({ trigger: request.trigger, occurrence: request.occurrence, startedAt });
                await this.record(task, request, startedAt);
                return { status: 'executed' };
            });

            if (!result.acquired) {
                this.logger.log(`Task "${task.name}" skipped: another instance holds its lock.`);
                return { status: 'skipped-locked' };
            }
            if (result.value.status === 'skipped-already-ran') {
                this.logger.log(`Task "${task.name}" skipped: occurrence ${request.occurrence} already ran.`);
            }
            return result.value;
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.logger.error(`Task "${task.name}" failed: ${detail}`, error instanceof Error ? error.stack : undefined);
            return { status: 'failed', error: detail };
        }
    }

    /** A task that ran must not be reported as failed because its bookkeeping row could not be written. */
    private async record(task: ScheduledTask, request: TaskRunRequest, startedAt: Date): Promise<void> {
        try {
            await this.runLog.record({
                taskName: task.name,
                occurrence: request.occurrence,
                trigger: request.trigger,
                startedAt,
                finishedAt: new Date(),
            });
        } catch (error) {
            this.logger.error(
                `Task "${task.name}" ran but its run could not be recorded: ` +
                    (error instanceof Error ? error.message : String(error)),
            );
        }
    }
}
