import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class RateDeliveryDto {
    @ApiProperty({ type: 'integer', minimum: 1, maximum: 5, example: 5, description: 'Customer rating for the completed delivery. One rating is allowed per delivery.' })
    @IsInt({ message: 'score must be an integer.' })
    @Min(1, { message: 'score must not be less than 1.' })
    @Max(5, { message: 'score must not be greater than 5.' })
    score!: number;

    @ApiPropertyOptional({ type: String, maxLength: 500, description: 'Optional plain-text customer comment. It is trimmed before storage; blank comments are stored as null.' })
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() || null : value))
    @IsOptional()
    @IsString({ message: 'comment must be a string.' })
    @MaxLength(500, { message: 'comment must not be longer than 500 characters.' })
    comment?: string | null;
}
