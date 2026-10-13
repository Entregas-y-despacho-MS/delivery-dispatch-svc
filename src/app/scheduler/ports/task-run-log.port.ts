import type { TaskTrigger } from './scheduled-task.js';

export interface TaskRunRecord {
    taskName: string;
    /** `null` for a manual run. */
    occurrence: string | null;
    trigger: TaskTrigger;
    startedAt: Date;
    finishedAt: Date;
}

/**
 * Remembers which occurrences of a scheduled task already ran **successfully**, across instances.
 * The lock alone is not enough: an instance whose clock is a second behind would take the lock after
 * the first one finished and run the same minute again.
 */
export abstract class TaskRunLog {
    abstract wasRecorded(occurrence: string): Promise<boolean>;
    abstract record(run: TaskRunRecord): Promise<void>;
}
