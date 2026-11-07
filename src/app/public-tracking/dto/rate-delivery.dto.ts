import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

export class RateDeliveryDto {
    @ApiProperty({ type: 'integer', minimum: 1, maximum: 5, example: 5, description: 'Customer rating for the completed delivery. One rating is allowed per delivery.' })
    @IsInt({ message: 'score must be an integer.' })
    @Min(1, { message: 'score must not be less than 1.' })
    @Max(5, { message: 'score must not be greater than 5.' })
    score!: number;
}
