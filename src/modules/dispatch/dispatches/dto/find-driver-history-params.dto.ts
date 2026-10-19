import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class FindDriverHistoryParamsDto {
    @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000)
    @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 1_000_000, default: 1, example: 1, description: 'One-based result page.' })
    page = 1;

    @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50)
    @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 50, default: 20, example: 20, description: 'Page size (1–50).' })
    limit = 20;

    @IsOptional() @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/)
    @ApiPropertyOptional({ type: String, format: 'date', description: 'Inclusive start date in YYYY-MM-DD, interpreted in America/La_Paz.' })
    from?: string;

    @IsOptional() @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/)
    @ApiPropertyOptional({ type: String, format: 'date', description: 'Inclusive end date in YYYY-MM-DD, interpreted in America/La_Paz.' })
    to?: string;

    @IsOptional() @IsIn(['delivered', 'returned'])
    @ApiPropertyOptional({ enum: ['delivered', 'returned'], description: 'Final status to include. If omitted, both statuses are included.' })
    status?: 'delivered' | 'returned';

    @IsOptional() @IsString() @MaxLength(100)
    @ApiPropertyOptional({ type: String, maxLength: 100, description: 'Case-insensitive partial match against the tracking code (up to 100 characters).' })
    search?: string;
}
