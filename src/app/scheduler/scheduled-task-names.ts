/**
 * Names of the tasks that can also be fired by hand (`POST /planning/...`). The feature that owns
 * the task registers it with exactly this name (`ScheduledTaskRegistry.register`); until it does,
 * the manual endpoint answers 503 `SCHEDULED_TASK_NOT_AVAILABLE`.
 */

/** The batch generator (ST-50.2). Schedule: `plan_generation_times`. */
export const PLAN_GENERATION_TASK = 'plan-generation';

/** The D-1 cutoff: optimization and validation of the batches (ST-51.3). Schedule: `route_cutoff_time`. */
export const ROUTE_CUTOFF_TASK = 'route-cutoff';
