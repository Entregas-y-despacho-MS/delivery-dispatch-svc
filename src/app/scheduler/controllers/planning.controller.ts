import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiInternalServerErrorResponse, ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { CoordinatorOnly } from '../../auth/decorators/index.js';
import { ApiConflict, ApiUnauthorized, ApiUnprocessableEntity, errorBody } from '../../../shared/utils/swagger/index.js';
import { TaskRunResultDto } from '../dto/task-run-result.dto.js';
import { PLAN_GENERATION_TASK, ROUTE_CUTOFF_TASK } from '../scheduled-task-names.js';
import { ManualTaskTriggerService } from '../services/manual-task-trigger.service.js';

const OSRM_UNAVAILABLE = errorBody(
    503,
    'OSRM_UNAVAILABLE',
    'The routing engine (OSRM) did not answer within 5 s. Try again in a few minutes.',
);

const NOT_AVAILABLE = errorBody(
    503,
    'SCHEDULED_TASK_NOT_AVAILABLE',
    'The task is not available: the feature that runs it has not registered it in this service.',
);

/**
 * Error dictionary:
 *   INVALID_TOKEN                  401 — JWT is missing, malformed, or expired.
 *   INSUFFICIENT_PERMISSIONS       403 — Authenticated but not a coordinator (or root).
 *   SCHEDULED_TASK_ALREADY_RUNNING 409 — The task holds its lock right now.
 *   PLANNING_SETTINGS_MISSING      422 — (generate) A mandatory setting is empty or invalid; `details.missingKeys` lists them.
 *   SCHEDULED_TASK_FAILED          500 — The task threw; the cause is in the server log.
 *   OSRM_UNAVAILABLE               503 — (generate) OSRM did not answer in 5 s; nothing was written.
 *   SCHEDULED_TASK_NOT_AVAILABLE   503 — Nobody registered the task in this service yet.
 *
 * ST-50.3 (D-40) — manual trigger of the scheduled tasks, for demos. Same lock as the schedule.
 */
@ApiTags('Planning')
@ApiBearerAuth('access-token')
@Controller('planning')
export class PlanningController {
    constructor(private readonly trigger: ManualTaskTriggerService) {}

    @Post('generate')
    @HttpCode(HttpStatus.OK)
    @CoordinatorOnly()
    @ApiOperation({
        summary:     'Run the batch generator now',
        description: 'Runs the batch generator (the same task the scheduler fires at the times of `plan_generation_times`) immediately and answers when it finishes. It takes the same cluster-wide lock as the scheduled run, so it never overlaps one, on this or any other instance: if the task is already running the answer is 409 and nothing is started. A manual run is recorded in the audit log with trigger `manual`. The answer carries a `summary` with the batches created and updated, the orders planned, and the exceptions and warnings for the coordinator. Answers 422 `PLANNING_SETTINGS_MISSING` when a mandatory setting is empty (a fresh database has `stop_service_minutes` and `planning_margin_pct` empty until the operation sets them) and 503 `OSRM_UNAVAILABLE` when the routing engine does not answer in 5 s, in which case nothing was written. Requires coordinator role, or root.',
    })
    @ApiOkResponse({ type: TaskRunResultDto })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiConflict({ code: 'SCHEDULED_TASK_ALREADY_RUNNING', message: 'The task is already running (started by the schedule, by another request or on another instance). Try again when it finishes.' })
    @ApiUnprocessableEntity({ code: 'PLANNING_SETTINGS_MISSING', message: 'The plan generator cannot run until the settings are fixed (missing: stop_service_minutes, planning_margin_pct). Set them with PUT /settings/:key.' })
    @ApiServiceUnavailableResponse({
        description: 'OSRM did not answer in time (`OSRM_UNAVAILABLE`, nothing was written), or the task is not registered in this service (`SCHEDULED_TASK_NOT_AVAILABLE`).',
        schema: { oneOf: [{ example: OSRM_UNAVAILABLE }, { example: NOT_AVAILABLE }] },
    })
    @ApiInternalServerErrorResponse({
        description: 'The generator threw an unexpected error while running (`SCHEDULED_TASK_FAILED`); the cause is in the server log and a rerun is safe.',
        schema: { example: errorBody(500, 'SCHEDULED_TASK_FAILED', 'The task failed. Nothing was recorded as done; the cause is in the server log.') },
    })
    async generate(): Promise<TaskRunResultDto> {
        return await this.trigger.trigger(PLAN_GENERATION_TASK);
    }

    @Post('cutoff')
    @HttpCode(HttpStatus.OK)
    @CoordinatorOnly()
    @ApiOperation({
        summary:     'Run the route cutoff now',
        description: 'Runs the D-1 cutoff (the same task the scheduler fires at `route_cutoff_time`) immediately and answers when it finishes. It takes the same cluster-wide lock as the scheduled run: if the task is already running the answer is 409 and nothing is started. A manual run is recorded in the audit log with trigger `manual`. Answers 503 while the cutoff has not been registered in this service. Requires coordinator role, or root.',
    })
    @ApiOkResponse({ type: TaskRunResultDto })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiConflict({ code: 'SCHEDULED_TASK_ALREADY_RUNNING', message: 'The task is already running (started by the schedule, by another request or on another instance). Try again when it finishes.' })
    @ApiServiceUnavailableResponse({ description: 'The task is not registered in this service.', schema: { example: NOT_AVAILABLE } })
    async cutoff(): Promise<TaskRunResultDto> {
        return await this.trigger.trigger(ROUTE_CUTOFF_TASK);
    }
}
