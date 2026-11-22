import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { INT4_MAX } from '../../../shared/constants/int4.js';
import { DispatchStatusEnum } from '../../../shared/enums/dispatch-status.enum.js';
import { OtdBasis } from '../domain/otd-basis.js';

const DATE_MESSAGE = (name: string) => `The '${name}' parameter must be a valid date in YYYY-MM-DD format.`;
const STATUSES = Object.values(DispatchStatusEnum);

/** Longest list of open overdue dispatches one request may return. */
export const OVERDUE_LIST_MAX_LIMIT = 100;
export const OVERDUE_LIST_DEFAULT_LIMIT = 50;

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value);

/** The filters both queries of the dashboard share (ST-301.1): the date range of the promise, zone, service level and status. */
export class DeliveryPromiseFiltersDto {
    // No `example` on the query parameters: Swagger UI would send it on "Try it out" (guarded by test/swagger.e2e-spec.ts).
    @ApiProperty({ type: String, format: 'date', description: 'First day of the range, in YYYY-MM-DD (e.g. 2026-11-01), inclusive. Bolivia days (America/La_Paz), matched against the end of the committed promise window (or, with `basis=deliveredAt`, against the closing time; in the backlog a dispatch without a window is placed by its closing time, or by its creation while it waits to be planned)' })
    @IsDateString({ strict: true }, { message: DATE_MESSAGE('from') })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE('from') })
    from!: string;

    @ApiProperty({ type: String, format: 'date', description: 'Last day of the range, in YYYY-MM-DD (e.g. 2026-11-30), inclusive (the whole day counts). Must not be before `from`, and the range must not exceed 366 days' })
    @IsDateString({ strict: true }, { message: DATE_MESSAGE('to') })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE('to') })
    to!: string;

    @ApiPropertyOptional({ type: 'integer', minimum: 1, description: 'Only dispatches of this delivery zone (ID)' })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: "The 'zoneId' parameter must be an integer." })
    @Min(1, { message: "The 'zoneId' parameter must be >= 1." })
    @Max(INT4_MAX, { message: `The 'zoneId' parameter must be <= ${INT4_MAX}.` })
    zoneId?: number;

    @ApiPropertyOptional({ type: 'integer', minimum: 1, description: 'Only dispatches of this service level (ID)' })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: "The 'serviceLevelId' parameter must be an integer." })
    @Min(1, { message: "The 'serviceLevelId' parameter must be >= 1." })
    @Max(INT4_MAX, { message: `The 'serviceLevelId' parameter must be <= ${INT4_MAX}.` })
    serviceLevelId?: number;

    @ApiPropertyOptional({ enum: STATUSES, description: 'Only dispatches in this current status. Without it, every status is counted' })
    @IsOptional()
    @Transform(lower)
    @IsIn(STATUSES, { message: `The 'status' parameter must be one of: ${STATUSES.join(', ')}.` })
    status?: DispatchStatusEnum;
}

export class OtdReportParamsDto extends DeliveryPromiseFiltersDto {
    @ApiPropertyOptional({ enum: OtdBasis, default: OtdBasis.PROMISE, description: '`promise` (default): OTD by cohort of expired promise, open dispatches included. `deliveredAt`: the historic punctuality of the completed deliveries by closing time (the ES-54 indicator), a different rate with its own denominator' })
    @IsOptional()
    @IsIn(Object.values(OtdBasis), { message: "The 'basis' parameter must be one of: promise, deliveredAt." })
    basis?: OtdBasis;
}

export class DeliveryBacklogParamsDto extends DeliveryPromiseFiltersDto {
    @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: OVERDUE_LIST_MAX_LIMIT, default: OVERDUE_LIST_DEFAULT_LIMIT, description: 'How many open overdue dispatches the list returns, the oldest first' })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: "The 'overdueLimit' parameter must be an integer." })
    @Min(1, { message: "The 'overdueLimit' parameter must be >= 1." })
    @Max(OVERDUE_LIST_MAX_LIMIT, { message: `The 'overdueLimit' parameter must be <= ${OVERDUE_LIST_MAX_LIMIT}.` })
    overdueLimit?: number;
}
