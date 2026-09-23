import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsPositive, IsString, MaxLength } from 'class-validator';
import { OptionalNotNull } from '../../../../shared/validators/optional-not-null.validator.js';

export class UpdateDeliveryZoneDto {
    @ApiPropertyOptional({ example: 'ZON-SUR', maxLength: 20, description: 'Código único de la zona' })
    @OptionalNotNull()
    @IsString()
    @MaxLength(20, { message: 'Code must not exceed 20 characters.' })
    code?: string;

    @ApiPropertyOptional({ example: 'Zona Sur', maxLength: 100 })
    @OptionalNotNull()
    @IsString()
    @MaxLength(100, { message: 'Name must not exceed 100 characters.' })
    name?: string;

    @ApiPropertyOptional({ example: 45, description: 'Tiempo base estimado de entrega, en minutos (entero positivo)' })
    @OptionalNotNull()
    @IsInt({ message: 'Estimated time must be an integer.' })
    @IsPositive({ message: 'Estimated time must be a positive number.' })
    estimatedTimeMin?: number;
}
