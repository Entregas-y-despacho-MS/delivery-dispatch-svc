import { ApiProperty } from '@nestjs/swagger';
import { PlanGenerationSummaryDto } from '../../planning/dto/plan-generation-summary.dto.js';

export class TaskRunResultDto {
    @ApiProperty({ example: 'plan-generation', description: 'Name of the task that ran (the same name the scheduler and the audit log use).' })
    task!: string;

    @ApiProperty({ example: 'executed', enum: ['executed'], description: 'Always `executed`: a task that is already running, unavailable or failed is answered with an error instead (409, 503 or 500).' })
    status!: 'executed';

    @ApiProperty({ type: String, format: 'date-time', description: 'When the task finished. The run is also recorded in the audit log with trigger `manual`.' })
    finishedAt!: Date;

    @ApiProperty({
        type: PlanGenerationSummaryDto,
        required: false,
        description: 'What the run did, when the task reports it. Only the batch generator does today (`POST /planning/generate`); absent for the others.',
    })
    summary?: PlanGenerationSummaryDto;
}
