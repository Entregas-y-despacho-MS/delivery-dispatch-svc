import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ReturnDispatchDto {
    @ApiPropertyOptional({
        type: String, maxLength: 500, nullable: true, example: 'Customer unreachable after three visits.',
        description: 'Free note of the coordinator about the return, kept in the audit event of the dispatch; `null` or omitted means none',
    })
    @IsOptional()
    @IsString({ message: 'notes must be a string.' })
    @MaxLength(500, { message: 'notes must not be longer than 500 characters.' })
    notes?: string | null;
}
