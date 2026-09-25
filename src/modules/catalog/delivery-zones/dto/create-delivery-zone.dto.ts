import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsPositive, IsString, MaxLength } from 'class-validator';

export class CreateDeliveryZoneDto {
    @ApiProperty({ example: 'ZON-SUR', maxLength: 20, description: 'Short unique code of the zone, used to refer to it (e.g. ZON-SUR). Must not belong to another zone' })
    @IsString()
    @IsNotEmpty({ message: 'Code is required.' })
    @MaxLength(20, { message: 'Code must not exceed 20 characters.' })
    code: string;

    @ApiProperty({ example: 'Zona Sur', maxLength: 100, description: 'Display name of the zone' })
    @IsString()
    @IsNotEmpty({ message: 'Name is required.' })
    @MaxLength(100, { message: 'Name must not exceed 100 characters.' })
    name: string;

    @ApiProperty({ type: 'integer', example: 45, minimum: 1, description: 'Base estimated delivery time in this zone, in minutes (a positive whole number)' })
    @IsInt({ message: 'Estimated time must be an integer.' })
    @IsPositive({ message: 'Estimated time must be a positive number.' })
    estimatedTimeMin: number;
}
