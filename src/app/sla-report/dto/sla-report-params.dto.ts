import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsEnum, Matches } from 'class-validator';
import { SlaGroupBy } from '../domain/sla-group-by.js';

const DATE_MESSAGE = (name: string) => `The '${name}' parameter must be a valid date in YYYY-MM-DD format.`;

/**
 * Same format and messages as the filters of the history, but both ends are required here (there
 * `from` and `to` are optional, so `PickType` would not do).
 */
export class SlaReportParamsDto {
    @ApiProperty({ type: String, format: 'date', example: '2026-10-01', description: 'First day of the range, in YYYY-MM-DD, inclusive. Bolivia days (America/La_Paz), matched against the closing time of the dispatch' })
    @IsDateString({ strict: true }, { message: DATE_MESSAGE('from') })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE('from') })
    from!: string;

    @ApiProperty({ type: String, format: 'date', example: '2026-10-31', description: 'Last day of the range, in YYYY-MM-DD, inclusive (the whole day counts). Must not be before `from`, and the range must not exceed 366 days' })
    @IsDateString({ strict: true }, { message: DATE_MESSAGE('to') })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE('to') })
    to!: string;

    @ApiProperty({ enum: SlaGroupBy, description: 'How the dispatches are grouped: by delivery zone (`zone`), by service level (`service_level`) or by the driver of the route (`driver`)' })
    @IsEnum(SlaGroupBy, { message: "The 'groupBy' parameter must be one of: zone, service_level, driver." })
    groupBy!: SlaGroupBy;
}
