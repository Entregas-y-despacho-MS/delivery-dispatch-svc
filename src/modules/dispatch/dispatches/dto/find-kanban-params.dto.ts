import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsInt, IsOptional, Matches, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class FindKanbanParamsDto {
    @IsOptional() @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/)
    @ApiPropertyOptional({ type: String, format: 'date', description: 'Operating date to display in YYYY-MM-DD format. Defaults to today in America/La_Paz.' })
    date?: string;

    @IsOptional() @Type(() => Number) @IsInt() @Min(1)
    @ApiPropertyOptional({ type: Number, description: 'Include only dispatches assigned to this delivery zone ID.' })
    delivery_zone_id?: number;

    @IsOptional() @Type(() => Number) @IsInt() @Min(1)
    @ApiPropertyOptional({ type: Number, description: 'Include only dispatches assigned to this driver ID.' })
    driver_id?: number;

    @IsOptional() @Type(() => Number) @IsInt() @Min(1)
    @ApiPropertyOptional({ type: Number, description: 'Include only dispatches with this dispatch type ID.' })
    dispatch_type_id?: number;
}
