import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, Matches } from 'class-validator';

export class FindDriverAssignmentsParamsDto {
    @IsOptional()
    @IsDateString({ strict: true }, { message: 'date must be a valid date in YYYY-MM-DD format.' })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be a valid date in YYYY-MM-DD format.' })
    @ApiPropertyOptional({ type: String, format: 'date', description: 'Shift date to list (YYYY-MM-DD). Format YYYY-MM-DD, e.g. 2026-10-14. Defaults to today in the operating time zone (America/La_Paz)' })
    date?: string;
}
