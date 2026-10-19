import { ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { PaginationParamsDto } from '../../../../shared/dto/index.js';
import { INT4_MAX } from '../../../../shared/constants/int4.js';
import { DispatchStatusEnum } from '../../../../shared/enums/dispatch-status.enum.js';
import { TERMINAL_DISPATCH_STATUSES } from '../../dispatches/utils/terminal-statuses.js';

export enum DispatchHistorySortBy {
    CLOSED_AT     = 'closedAt',
    TRACKING_CODE = 'trackingCode',
    RECIPIENT     = 'recipient',
    DRIVER        = 'driver',
    PLATE         = 'plate',
    STATUS        = 'status',
}

const SORT_BY_MESSAGE = "The 'sortBy' parameter must be one of: closedAt, trackingCode, recipient, driver, plate, status.";
const DATE_MESSAGE = (name: string) => `The '${name}' parameter must be a valid date in YYYY-MM-DD format.`;

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Filters shared by the history listing and its CSV export (ST-55.2): the export applies exactly the
 * filters the screen shows, so both endpoints take this class.
 */
export class DispatchHistoryFiltersDto {
    @ApiPropertyOptional({ type: String, format: 'date', description: 'First day of the range, in YYYY-MM-DD (e.g. 2026-10-01), inclusive. Days are Bolivia days (America/La_Paz) and are matched against the closing time of the dispatch' })
    @IsOptional()
    @IsDateString({ strict: true }, { message: DATE_MESSAGE('from') })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE('from') })
    from?: string;

    @ApiPropertyOptional({ type: String, format: 'date', description: 'Last day of the range, in YYYY-MM-DD (e.g. 2026-10-31), inclusive (the whole day counts). Bolivia days, matched against the closing time. Must not be before `from`' })
    @IsOptional()
    @IsDateString({ strict: true }, { message: DATE_MESSAGE('to') })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE('to') })
    to?: string;

    @ApiPropertyOptional({ type: 'integer', description: 'Only dispatches of the route driven by this driver (user ID)' })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: "The 'driverId' parameter must be an integer." })
    @Min(1, { message: "The 'driverId' parameter must be >= 1." })
    @Max(INT4_MAX, { message: `The 'driverId' parameter must be <= ${INT4_MAX}.` })
    driverId?: number;

    @ApiPropertyOptional({ maxLength: 15, description: 'Text contained in the plate of the vehicle of the route (case-insensitive; % and _ are matched literally)' })
    @IsOptional()
    @Transform(trim)
    @IsString()
    @MaxLength(15, { message: "The 'plate' parameter must not exceed 15 characters." })
    plate?: string;

    @ApiPropertyOptional({ enum: TERMINAL_DISPATCH_STATUSES, description: 'Final status. Only terminal statuses exist in the history; without this filter, all of them are listed' })
    @IsOptional()
    @Transform(lower)
    @IsIn(TERMINAL_DISPATCH_STATUSES, { message: `The 'status' parameter must be one of: ${TERMINAL_DISPATCH_STATUSES.join(', ')}.` })
    status?: DispatchStatusEnum;

    @ApiPropertyOptional({ maxLength: 100, description: 'Text contained in the tracking code (código de guía), case-insensitive; % and _ are matched literally' })
    @IsOptional()
    @Transform(trim)
    @IsString()
    @MaxLength(100, { message: "The 'search' parameter must not exceed 100 characters." })
    search?: string;
}

export class DispatchHistorySortDto {
    @ApiPropertyOptional({ enum: DispatchHistorySortBy, default: DispatchHistorySortBy.CLOSED_AT, description: 'Field to sort by. Default: closedAt' })
    @IsOptional()
    @IsIn(Object.values(DispatchHistorySortBy), { message: SORT_BY_MESSAGE })
    sortBy?: DispatchHistorySortBy;

    @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc', description: 'Sort direction. Default: desc (most recent first)' })
    @IsOptional()
    @Transform(lower)
    @IsIn(['asc', 'desc'], { message: "The 'order' parameter must be 'asc' or 'desc'." })
    order?: 'asc' | 'desc';
}

/** The listing: the filters, the sort and the page. */
export class FindDispatchHistoryParamsDto extends IntersectionType(
    IntersectionType(DispatchHistoryFiltersDto, DispatchHistorySortDto),
    PaginationParamsDto,
) {}

/** The CSV export: the same filters and sort as the listing, never paginated. */
export class ExportDispatchHistoryParamsDto extends IntersectionType(DispatchHistoryFiltersDto, DispatchHistorySortDto) {}
