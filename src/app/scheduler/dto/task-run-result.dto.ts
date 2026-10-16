import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { PlanGenerationSummaryDto } from '../../planning/dto/plan-generation-summary.dto.js';
import { RouteCutoffSummaryDto } from '../../route-cutoff/dto/route-cutoff-summary.dto.js';

@ApiExtraModels(PlanGenerationSummaryDto, RouteCutoffSummaryDto)
export class TaskRunResultDto {
    @ApiProperty({ example: 'plan-generation', description: 'Name of the task that ran (the same name the scheduler and the audit log use).' })
    task!: string;

    @ApiProperty({ example: 'executed', enum: ['executed'], description: 'Always `executed`: a task that is already running, unavailable or failed is answered with an error instead (409, 503 or 500).' })
    status!: 'executed';

    @ApiProperty({ type: String, format: 'date-time', description: 'When the task finished. The run is also recorded in the audit log with trigger `manual`.' })
    finishedAt!: Date;

    @ApiProperty({
        required: false,
        oneOf: [{ $ref: getSchemaPath(PlanGenerationSummaryDto) }, { $ref: getSchemaPath(RouteCutoffSummaryDto) }],
        description: 'What the run did, when the task reports it: the batch generator (`POST /planning/generate`) and the D-1 cutoff (`POST /planning/cutoff`) do; absent for the others.',
    })
    summary?: PlanGenerationSummaryDto | RouteCutoffSummaryDto;
}
