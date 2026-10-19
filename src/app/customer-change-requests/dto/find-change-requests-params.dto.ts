import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { INT4_MAX } from '../../../shared/constants/int4.js';
import { PaginationParamsDto } from '../../../shared/dto/index.js';

// The names of the filters follow the other lists of dispatches (`delivery_zone_id`, `date`, `search`).
export class FindChangeRequestsParamsDto extends PaginationParamsDto {
    @ApiPropertyOptional({ type: 'integer', description: 'Only requests of deliveries of this delivery zone.' })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: "The 'delivery_zone_id' parameter must be an integer." })
    @Min(1, { message: "The 'delivery_zone_id' parameter must be >= 1." })
    @Max(INT4_MAX, { message: `The 'delivery_zone_id' parameter must be <= ${INT4_MAX}.` })
    delivery_zone_id?: number;

    @ApiPropertyOptional({ type: String, format: 'date', description: 'Only requests of deliveries whose route is on this date (YYYY-MM-DD, local date of the route batch).' })
    @IsOptional()
    @IsDateString({ strict: true }, { message: 'date must be a valid date in YYYY-MM-DD format.' })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be a valid date in YYYY-MM-DD format.' })
    date?: string;

    @ApiPropertyOptional({ maxLength: 100, description: 'Text contained in the tracking code or in the contact name (case-insensitive; % and _ are matched literally).' })
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    @IsString()
    @MaxLength(100, { message: "The 'search' parameter must not exceed 100 characters." })
    search?: string;
}
