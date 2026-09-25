import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsPositive, IsString, MaxLength } from 'class-validator';
import { OptionalNotNull } from '../../../../shared/validators/optional-not-null.validator.js';

export class UpdateDeliveryZoneDto {
    @ApiPropertyOptional({ example: 'ZON-SUR', maxLength: 20, description: 'New code. Must not belong to another zone. null is rejected' })
    @OptionalNotNull()
    @IsString()
    @MaxLength(20, { message: 'Code must not exceed 20 characters.' })
    code?: string;

    @ApiPropertyOptional({ example: 'Zona Sur', maxLength: 100, description: 'New display name. null is rejected' })
    @OptionalNotNull()
    @IsString()
    @MaxLength(100, { message: 'Name must not exceed 100 characters.' })
    name?: string;

    @ApiPropertyOptional({ type: 'integer', example: 45, minimum: 1, description: 'New base estimated delivery time, in minutes (a positive whole number). null is rejected' })
    @OptionalNotNull()
    @IsInt({ message: 'Estimated time must be an integer.' })
    @IsPositive({ message: 'Estimated time must be a positive number.' })
    estimatedTimeMin?: number;
}
