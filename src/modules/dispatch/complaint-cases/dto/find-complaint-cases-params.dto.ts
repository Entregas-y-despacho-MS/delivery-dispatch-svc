import { ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { PaginationParamsDto } from '../../../../shared/dto/index.js';
import { INT4_MAX } from '../../../../shared/constants/int4.js';

export const COMPLAINT_INVESTIGATION_STATUSES = ['received', 'assigned', 'in_investigation', 'decided'] as const;

const DATE_MESSAGE = (name: string) => `The '${name}' parameter must be a valid date in YYYY-MM-DD format.`;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value);

// From the year 1900: Postgres cannot cast year 0000 to a date, which would be a 500 instead of a 400.
const DATE_PATTERN = /^(19|[2-9]\d)\d{2}-\d{2}-\d{2}$/;

/** Filters of the complaint inbox (ST-45.2): they combine with AND. */
export class ComplaintCaseFiltersDto {
    @ApiPropertyOptional({ type: String, format: 'date', description: 'First day of the range, in YYYY-MM-DD, inclusive. Bolivia days (America/La_Paz), matched against the time the complaint was received' })
    @IsOptional()
    @IsDateString({ strict: true }, { message: DATE_MESSAGE('from') })
    @Matches(DATE_PATTERN, { message: DATE_MESSAGE('from') })
    from?: string;

    @ApiPropertyOptional({ type: String, format: 'date', description: 'Last day of the range, in YYYY-MM-DD, inclusive (the whole day counts). Must not be before `from`' })
    @IsOptional()
    @IsDateString({ strict: true }, { message: DATE_MESSAGE('to') })
    @Matches(DATE_PATTERN, { message: DATE_MESSAGE('to') })
    to?: string;

    @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 2147483647, description: 'Only cases whose dispatch belongs to this delivery zone (zone ID)' })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: "The 'zoneId' parameter must be an integer." })
    @Min(1, { message: "The 'zoneId' parameter must be >= 1." })
    @Max(INT4_MAX, { message: `The 'zoneId' parameter must be <= ${INT4_MAX}.` })
    zoneId?: number;

    @ApiPropertyOptional({ type: String, maxLength: 40, description: 'Reason code of the complaint, exact match (case-insensitive), as CRM sent it' })
    @IsOptional()
    @Transform(trim)
    @IsString()
    @MaxLength(40, { message: "The 'reasonCode' parameter must not exceed 40 characters." })
    reasonCode?: string;

    @ApiPropertyOptional({ enum: COMPLAINT_INVESTIGATION_STATUSES, description: 'Investigation status of the case' })
    @IsOptional()
    @Transform(lower)
    @IsIn(COMPLAINT_INVESTIGATION_STATUSES, { message: `The 'status' parameter must be one of: ${COMPLAINT_INVESTIGATION_STATUSES.join(', ')}.` })
    status?: typeof COMPLAINT_INVESTIGATION_STATUSES[number];

    @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 2147483647, description: 'Only cases assigned to this user (user ID)' })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: "The 'assignedUserId' parameter must be an integer." })
    @Min(1, { message: "The 'assignedUserId' parameter must be >= 1." })
    @Max(INT4_MAX, { message: `The 'assignedUserId' parameter must be <= ${INT4_MAX}.` })
    assignedUserId?: number;
}

export class FindComplaintCasesParamsDto extends IntersectionType(ComplaintCaseFiltersDto, PaginationParamsDto) {}
