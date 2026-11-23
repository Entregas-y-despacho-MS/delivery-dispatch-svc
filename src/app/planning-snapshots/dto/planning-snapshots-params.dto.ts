import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { INT4_MAX } from '../../../shared/constants/int4.js';
import { PIPELINE_SHIFTS, type PipelineShift } from '../../planning-pipeline/dto/planning-pipeline-params.dto.js';

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

/** Day of the routes, as the planning pipeline reads it (ST-302.1). */
export class OperatingDateParamsDto {
    // No `example` on the query parameters: Swagger UI would send it on "Try it out" (guarded by test/swagger.e2e-spec.ts).
    @ApiPropertyOptional({ type: String, format: 'date', description: 'Operating day of the routes in YYYY-MM-DD (America/La_Paz): the shift date the cutoff planned. Default: today' })
    @IsOptional()
    @IsDateString({ strict: true }, { message: DATE_MESSAGE })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE })
    date?: string;
}

/** The dashboard filters that apply to a snapshot or a manifest (rule 9 of the HU). The batch is never a filter. */
export class SnapshotFiltersDto extends OperatingDateParamsDto {
    @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: INT4_MAX, description: 'Only dispatches of this delivery zone (ID), the zone the batch had at the cutoff' })
    @positiveInt('zoneId')
    zoneId?: number;

    @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: INT4_MAX, description: 'Only dispatches of this origin warehouse (ID), the one the batch had at the cutoff' })
    @positiveInt('warehouseId')
    warehouseId?: number;

    @ApiPropertyOptional({ enum: PIPELINE_SHIFTS, description: 'Only dispatches whose promise window starts in this shift (`morning` before 12:00, `afternoon` from 12:00, America/La_Paz). A dispatch without a window has no shift and is left out when this filter is used' })
    @IsOptional()
    @Transform(lower)
    @IsIn(PIPELINE_SHIFTS, { message: `The 'shift' parameter must be one of: ${PIPELINE_SHIFTS.join(', ')}.` })
    shift?: PipelineShift;
}

export class CutoffCoverageParamsDto extends SnapshotFiltersDto {
    @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: INT4_MAX, description: 'A specific cutoff (ID, from `GET /planning/cutoffs`). Without it the official cutoff of `date` is used: the first scheduled one' })
    @positiveInt('cutoffId')
    cutoffId?: number;
}
