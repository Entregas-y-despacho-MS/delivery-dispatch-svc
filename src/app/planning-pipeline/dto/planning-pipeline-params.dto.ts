import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { INT4_MAX } from '../../../shared/constants/int4.js';
import { PaginationParamsDto } from '../../../shared/dto/pagination-params.dto.js';
import { PipelineStage } from '../domain/pipeline-stage.js';

export const PIPELINE_SHIFTS = ['morning', 'afternoon'] as const;
export type PipelineShift = (typeof PIPELINE_SHIFTS)[number];

const STAGES = Object.values(PipelineStage);
const DATE_MESSAGE = "The 'date' parameter must be a valid date in YYYY-MM-DD format.";
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value);

function positiveInt(name: string) {
    return (target: object, key: string) => {
        IsOptional()(target, key);
        Type(() => Number)(target, key);
        IsInt({ message: `The '${name}' parameter must be an integer.` })(target, key);
        Min(1, { message: `The '${name}' parameter must be >= 1.` })(target, key);
        Max(INT4_MAX, { message: `The '${name}' parameter must be <= ${INT4_MAX}.` })(target, key);
    };
}

/** Filters of the planning pipeline (ST-302.1). The batch is not a filter: it is only detail of each dispatch. */
export class PlanningPipelineParamsDto extends PaginationParamsDto {
    // No `example` on the query parameters: Swagger UI would send it on "Try it out" (guarded by test/swagger.e2e-spec.ts).
    @ApiPropertyOptional({ type: String, format: 'date', description: 'Operating day in YYYY-MM-DD (America/La_Paz): the shift date of the batch, or the day of the promise window for a dispatch without batch. A dispatch with neither carries over: it shows from the day it was created. Default: today' })
    @IsOptional()
    @IsDateString({ strict: true }, { message: DATE_MESSAGE })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE })
    date?: string;

    @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: INT4_MAX, description: 'Only dispatches of this delivery zone (ID)' })
    @positiveInt('zoneId')
    zoneId?: number;

    @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: INT4_MAX, description: 'Only dispatches of this origin warehouse (ID)' })
    @positiveInt('warehouseId')
    warehouseId?: number;

    @ApiPropertyOptional({ enum: PIPELINE_SHIFTS, description: 'Only dispatches whose window starts in this shift (`morning` before 12:00, `afternoon` from 12:00, America/La_Paz). A dispatch without a window has no shift and is left out when this filter is used' })
    @IsOptional()
    @Transform(lower)
    @IsIn(PIPELINE_SHIFTS, { message: `The 'shift' parameter must be one of: ${PIPELINE_SHIFTS.join(', ')}.` })
    shift?: PipelineShift;

    @ApiPropertyOptional({ enum: STAGES, description: 'Only dispatches in this stage. The `summary` still counts every stage of the other filters' })
    @IsOptional()
    @Transform(lower)
    @IsIn(STAGES, { message: `The 'stage' parameter must be one of: ${STAGES.join(', ')}.` })
    stage?: PipelineStage;
}
