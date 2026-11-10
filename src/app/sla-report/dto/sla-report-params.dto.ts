import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsIn, Matches } from 'class-validator';
import { SlaGroupBy } from '../domain/sla-group-by.js';

/** The groupings `GET /reports/sla` accepts: `vehicle` belongs to the fleet KPIs (ST-61.1). */
const REPORT_GROUPINGS = [SlaGroupBy.ZONE, SlaGroupBy.SERVICE_LEVEL, SlaGroupBy.ZONE_SERVICE, SlaGroupBy.DRIVER];

const DATE_MESSAGE = (name: string) => `The '${name}' parameter must be a valid date in YYYY-MM-DD format.`;

/**
 * Same format and messages as the filters of the history, but both ends are required here (there
 * `from` and `to` are optional, so `PickType` would not do).
 */
export class SlaReportParamsDto {
    // No `example` on the query parameters: Swagger UI would send it on "Try it out" (guarded by test/swagger.e2e-spec.ts).
    @ApiProperty({ type: String, format: 'date', description: 'First day of the range, in YYYY-MM-DD (e.g. 2026-10-01), inclusive. Bolivia days (America/La_Paz), matched against the closing time of the dispatch' })
    @IsDateString({ strict: true }, { message: DATE_MESSAGE('from') })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE('from') })
    from!: string;

    @ApiProperty({ type: String, format: 'date', description: 'Last day of the range, in YYYY-MM-DD (e.g. 2026-10-31), inclusive (the whole day counts). Must not be before `from`, and the range must not exceed 366 days' })
    @IsDateString({ strict: true }, { message: DATE_MESSAGE('to') })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE('to') })
    to!: string;

    @ApiProperty({ enum: REPORT_GROUPINGS, description: 'How the dispatches are grouped: by zone (`zone`), service level (`service_level`), zone and service together (`zone_service`) or driver (`driver`)' })
    @IsIn(REPORT_GROUPINGS, { message: "The 'groupBy' parameter must be one of: zone, service_level, zone_service, driver." })
    groupBy!: SlaGroupBy;
}
