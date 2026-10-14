import type { TaskSchedule } from '../domain/task-schedule.js';

/** What started the run: the clock or a person asking for it (`POST /planning/...`). */
export type TaskTrigger = 'schedule' | 'manual';

export interface ScheduledTaskContext {
    trigger: TaskTrigger;
    /**
     * Identifies the scheduled occurrence (`route-cutoff@2026-10-13T15:00`); `null` for a manual run.
     * Useful to make the task's own writes idempotent per occurrence.
     */
    occurrence: string | null;
    startedAt: Date;
}

/**
 * A task the scheduler can run. A feature registers its tasks with `ScheduledTaskRegistry.register`
 * (normally in `onModuleInit`); the scheduler decides when it is due, takes the cluster-wide lock
 * and calls `run`.
 *
 * `run` must be **idempotent**: if it fails, another instance may run the same occurrence again
 * within the same minute, and a manual run can happen at any time.
 */
export interface ScheduledTask {
    /** Unique, kebab-case (`plan-generation`). It is also the lock key and what the audit log records. */
    readonly name: string;
    readonly schedule: TaskSchedule;
    /**
     * May return a summary of what it did: a manual trigger puts it in the response. Throwing an
     * `HttpException` (422, 503...) makes a manual trigger answer with that same status.
     */
    run(context: ScheduledTaskContext): Promise<unknown>;
}
