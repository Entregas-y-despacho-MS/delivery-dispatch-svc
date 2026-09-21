import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsPositive, IsString, MaxLength } from 'class-validator';

export class CreateDeliveryZoneDto {
    @ApiProperty({ example: 'ZON-SUR', maxLength: 20, description: 'Código único de la zona' })
    @IsString()
    @IsNotEmpty({ message: 'Code is required.' })
    @MaxLength(20, { message: 'Code must not exceed 20 characters.' })
    code: string;

    @ApiProperty({ example: 'Zona Sur', maxLength: 100 })
    @IsString()
    @IsNotEmpty({ message: 'Name is required.' })
    @MaxLength(100, { message: 'Name must not exceed 100 characters.' })
    name: string;

    @ApiProperty({ example: 45, description: 'Tiempo base estimado de entrega, en minutos (entero positivo)' })
    @IsInt({ message: 'Estimated time must be an integer.' })
    @IsPositive({ message: 'Estimated time must be a positive number.' })
    estimatedTimeMin: number;
}
