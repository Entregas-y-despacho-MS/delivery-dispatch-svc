import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { INT4_MAX } from '../../../shared/constants/int4.js';
import { DispatchStatusEnum } from '../../../shared/enums/dispatch-status.enum.js';

const DATE_MESSAGE = (name: string) => `The '${name}' parameter must be a valid date in YYYY-MM-DD format.`;
const STATUSES = Object.values(DispatchStatusEnum);

export const EXCEPTION_LIST_MAX_LIMIT = 100;
export const EXCEPTION_LIST_DEFAULT_LIMIT = 50;

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value);

/** Filters of `GET /reports/supplier-pickups` (ST-305.1). */
export class SupplierPickupComplianceParamsDto {
    // No `example` on the query parameters: Swagger UI would send it on "Try it out" (guarded by test/swagger.e2e-spec.ts).
    @ApiProperty({ type: String, format: 'date', description: 'First day of the range, in YYYY-MM-DD (e.g. 2026-11-01), inclusive. Bolivia days (America/La_Paz), matched against the end of the appointment window in force (an appointment without a valid window is placed by its closing time, or by its creation)' })
    @IsDateString({ strict: true }, { message: DATE_MESSAGE('from') })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE('from') })
    from!: string;

    @ApiProperty({ type: String, format: 'date', description: 'Last day of the range, in YYYY-MM-DD (e.g. 2026-11-30), inclusive (the whole day counts). Must not be before `from`, and the range must not exceed 366 days' })
    @IsDateString({ strict: true }, { message: DATE_MESSAGE('to') })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE('to') })
    to!: string;

    @ApiPropertyOptional({ type: String, maxLength: 100, description: 'Only pickups of this supplier (the `supplierId` Compras sent). It is read from the most recent dispatch event that carries a supplier, there is no column for it' })
    @IsOptional()
    @IsString({ message: "The 'supplierId' parameter must be a string." })
    @MaxLength(100, { message: "The 'supplierId' parameter must be at most 100 characters." })
    supplierId?: string;

    @ApiPropertyOptional({ type: 'integer', minimum: 1, description: 'Only pickups whose destination is this warehouse (ID)' })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: "The 'warehouseId' parameter must be an integer." })
    @Min(1, { message: "The 'warehouseId' parameter must be >= 1." })
    @Max(INT4_MAX, { message: `The 'warehouseId' parameter must be <= ${INT4_MAX}.` })
    warehouseId?: number;

    @ApiPropertyOptional({ type: 'integer', minimum: 1, description: 'Only pickups of this delivery zone (ID). Supplier pickups usually carry no zone, so this filter may leave nothing' })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: "The 'zoneId' parameter must be an integer." })
    @Min(1, { message: "The 'zoneId' parameter must be >= 1." })
    @Max(INT4_MAX, { message: `The 'zoneId' parameter must be <= ${INT4_MAX}.` })
    zoneId?: number;

    @ApiPropertyOptional({ enum: STATUSES, description: 'Only pickups in this current status. Without it, every status is counted' })
    @IsOptional()
    @Transform(lower)
    @IsIn(STATUSES, { message: `The 'status' parameter must be one of: ${STATUSES.join(', ')}.` })
    status?: DispatchStatusEnum;

    @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: EXCEPTION_LIST_MAX_LIMIT, default: EXCEPTION_LIST_DEFAULT_LIMIT, description: 'How many actionable exceptions the list returns, the most overdue first' })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: "The 'exceptionLimit' parameter must be an integer." })
    @Min(1, { message: "The 'exceptionLimit' parameter must be >= 1." })
    @Max(EXCEPTION_LIST_MAX_LIMIT, { message: `The 'exceptionLimit' parameter must be <= ${EXCEPTION_LIST_MAX_LIMIT}.` })
    exceptionLimit?: number;
}
