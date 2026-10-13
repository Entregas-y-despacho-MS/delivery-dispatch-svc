/** Outcome of `TaskLock.runExclusive`. */
export type ExclusiveResult<T> = { acquired: true; value: T } | { acquired: false };

/**
 * Cluster-wide mutual exclusion for scheduled tasks (ST-50.3, D-40): at most one backend instance
 * runs a task at a time. Consumers inject this port, never an adapter.
 *
 * It is a *try* lock: when another instance holds the task, the call returns `{ acquired: false }`
 * immediately and does not wait. The lock is held only while `work` runs and is always released,
 * also when `work` throws (the error propagates to the caller).
 */
export abstract class TaskLock {
    abstract runExclusive<T>(taskName: string, work: () => Promise<T>): Promise<ExclusiveResult<T>>;
}
