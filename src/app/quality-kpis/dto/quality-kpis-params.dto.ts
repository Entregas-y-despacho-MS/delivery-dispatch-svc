import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { INT4_MAX } from '../../../shared/constants/int4.js';
import { PaginationParamsDto } from '../../../shared/dto/index.js';
import { DispatchStatusEnum } from '../../../shared/enums/dispatch-status.enum.js';
import { transformToBoolean } from '../../../shared/utils/transformers.util.js';
import { OPERATING_TIME_ZONE } from '../../../modules/dispatch/dispatches/utils/operating-date.util.js';

const DATE_MESSAGE = (name: string) => `The '${name}' parameter must be a valid date in YYYY-MM-DD format.`;
const STATUSES = Object.values(DispatchStatusEnum);
const ORDERS = ['asc', 'desc'] as const;

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Query of the quality dashboard (ST-300.2, ES-300, Dashboard 4). Every filter combines with AND. `page`/`limit` paginate both tables
 * (cases and dispatches) at once; the indicators always cover the whole filtered cohort, never just the page.
 */
export class QualityKpisParamsDto extends PaginationParamsDto {
    // No `example` on the query parameters of this class: Swagger UI would send it on "Try it out" (guarded by test/swagger.e2e-spec.ts). `page` and `limit` keep the ones of `PaginationParamsDto`.
    @ApiProperty({ type: String, format: 'date', description: 'First day of the range, in YYYY-MM-DD (e.g. 2026-11-01), inclusive. Bolivia days (America/La_Paz). Incidents and reschedules are placed by the end of the promise window; claims and ratings by the closing of the delivery' })
    @IsDateString({ strict: true }, { message: DATE_MESSAGE('from') })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE('from') })
    from!: string;

    @ApiProperty({ type: String, format: 'date', description: 'Last day of the range, in YYYY-MM-DD (e.g. 2026-11-30), inclusive (the whole day counts). Must not be before `from`, and the range must not exceed 366 days' })
    @IsDateString({ strict: true }, { message: DATE_MESSAGE('to') })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE('to') })
    to!: string;

    @ApiPropertyOptional({ type: String, enum: [OPERATING_TIME_ZONE], description: `Time zone the days are read and shown in. Only \`${OPERATING_TIME_ZONE}\` is accepted (the default): the calculation is always done on UTC timestamps` })
    @IsOptional()
    @IsIn([OPERATING_TIME_ZONE], { message: `The 'timeZone' parameter must be ${OPERATING_TIME_ZONE}.` })
    timeZone?: string;

    @ApiPropertyOptional({ type: 'integer', minimum: 1, description: 'Only dispatches of this delivery zone (ID)' })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: "The 'zoneId' parameter must be an integer." })
    @Min(1, { message: "The 'zoneId' parameter must be >= 1." })
    @Max(INT4_MAX, { message: `The 'zoneId' parameter must be <= ${INT4_MAX}.` })
    zoneId?: number;

    @ApiPropertyOptional({ type: 'integer', minimum: 1, description: 'Incident reason (ID of the catalog): only the incidents with this reason count in the numerator of the incident rate; the denominator stays the valid attempts' })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: "The 'incidentReasonId' parameter must be an integer." })
    @Min(1, { message: "The 'incidentReasonId' parameter must be >= 1." })
    @Max(INT4_MAX, { message: `The 'incidentReasonId' parameter must be <= ${INT4_MAX}.` })
    incidentReasonId?: number;

    @ApiPropertyOptional({ type: String, maxLength: 40, description: 'Reason code of the CRM complaint, exact match (case-insensitive): only the cases with it count in the claim indicators; the delivered dispatches stay the denominator' })
    @IsOptional()
    @Transform(trim)
    @IsString()
    @MaxLength(40, { message: "The 'reasonCode' parameter must not exceed 40 characters." })
    reasonCode?: string;

    @ApiPropertyOptional({ enum: STATUSES, description: 'Current status of the dispatch, applied to every indicator. A status other than `delivered` leaves claims and ratings in «Sin datos»; `delivered` leaves incidents and reschedules measuring only what ended well' })
    @IsOptional()
    @Transform(lower)
    @IsIn(STATUSES, { message: `The 'status' parameter must be one of: ${STATUSES.join(', ')}.` })
    status?: DispatchStatusEnum;

    @ApiPropertyOptional({ type: Boolean, description: '`true`: only dispatches whose delivery window was changed at least once; `false`: only those never changed (a route reassignment alone is not a reschedule). Omitted: all' })
    @IsOptional()
    @Transform(({ value }) => transformToBoolean(value, 'rescheduled') ?? undefined)
    rescheduled?: boolean;

    @ApiPropertyOptional({ enum: ORDERS, default: 'desc', description: 'Order of both tables by their id (case id, dispatch id). Stable: the id is unique' })
    @IsOptional()
    @Transform(lower)
    @IsIn(ORDERS, { message: "The 'order' parameter must be one of: asc, desc." })
    order?: (typeof ORDERS)[number];
}
