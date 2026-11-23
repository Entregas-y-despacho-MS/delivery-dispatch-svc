import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiBadRequests, ApiForbidden, ApiUnauthorized } from '../../../shared/utils/swagger/index.js';
import { CoordinatorOnly } from '../../auth/decorators/index.js';
import { PlanningPipelineResponseDto } from '../dto/planning-pipeline.dto.js';
import { PlanningPipelineParamsDto } from '../dto/planning-pipeline-params.dto.js';
import { PlanningPipelineService } from '../services/planning-pipeline.service.js';

/**
 * ST-302.1 (ES-302, Dashboard 2: planning and execution of routes) — the pipeline by individual dispatch.
 *
 * Error dictionary: VALIDATION_FAILED 400 (invalid `date`, `zoneId`, `warehouseId`, `shift`, `stage`, `page` or `limit`) |
 * INVALID_TOKEN 401 | INSUFFICIENT_PERMISSIONS 403.
 */
@ApiTags('Planning pipeline')
@ApiBearerAuth('access-token')
@Controller('planning/pipeline')
export class PlanningPipelineController {
    constructor(private readonly service: PlanningPipelineService) {}

    @Get()
    @CoordinatorOnly()
    @ApiOperation({
        summary: 'Planning pipeline by individual dispatch: stage, batch detail and capacity in kg and m³ apart',
        description:
            "Lists the dispatches of an operating day (`date`, YYYY-MM-DD, Bolivia day, default today) in exactly one stage each: `ready_unbatched` (ready and without batch; it is not the whole backlog, the other stages are counted beside it), `provisional_review` (in a provisional batch or in final review), `confirmed_assigned` (in a confirmed batch), `in_execution` (route running) or `exception` (address or zone to fix, no plan possible, capacity exceeded, inconsistent state). Every count is by dispatch (`dispatchId`): `summary.byStage` counts the dispatches of the filters, whatever their batch. The batch comes only as detail in `batches`, with the load against its vehicle in kg (`weight`) and in m³ (`volume`) as two separate measures with their own excess; there is no combined percentage, and a batch without vehicle has `capacity: null`. An `exception` carries its `codes` and a `reason` text, and `detailPath` opens the dispatch detail to solve it. Dispatches finished, cancelled, returned, rescheduled or in incident are not part of the pipeline. The shift is derived from the start of the promise window (before 12:00 `morning`, from 12:00 `afternoon`, America/La_Paz) because there is no shift table. Filters: operating date, zone, origin warehouse, shift and stage (the `summary` still counts every stage). Paginated, most urgent first. Not cached. Requires coordinator role, or root.",
    })
    @ApiOkResponse({ type: PlanningPipelineResponseDto })
    @ApiBadRequests({
        validation: true,
        example: ["The 'date' parameter must be a valid date in YYYY-MM-DD format.", "The 'shift' parameter must be one of: morning, afternoon."],
    })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    async getPipeline(@Query() params: PlanningPipelineParamsDto): Promise<PlanningPipelineResponseDto> {
        return await this.service.getPipeline(params);
    }
}
