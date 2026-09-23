import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength } from 'class-validator';

const MAX_CAPACITY = 99999999.99;

const normalizePlate = ({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value;

export class UpdateVehicleDto {
    @ApiPropertyOptional({ example: 'camioneta', maxLength: 50 })
    @IsOptional()
    @IsString()
    @IsNotEmpty({ message: 'Type must not be empty.' })
    @MaxLength(50, { message: 'Type must not exceed 50 characters.' })
    type?: string;

    @ApiPropertyOptional({ example: 'Toyota Hilux 2022', maxLength: 100 })
    @IsOptional()
    @IsString()
    @IsNotEmpty({ message: 'Model must not be empty.' })
    @MaxLength(100, { message: 'Model must not exceed 100 characters.' })
    model?: string;

    @ApiPropertyOptional({ example: '1234-ABC', maxLength: 15 })
    @IsOptional()
    @Transform(normalizePlate)
    @IsString()
    @IsNotEmpty({ message: 'Plate must not be empty.' })
    @MaxLength(15, { message: 'Plate must not exceed 15 characters.' })
    plate?: string;

    @ApiPropertyOptional({ example: 1200.5 })
    @IsOptional()
    @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Capacity in kg must be a number with at most 2 decimals.' })
    @IsPositive({ message: 'Capacity in kg must be greater than zero.' })
    @Max(MAX_CAPACITY, { message: 'Capacity in kg is too large.' })
    capacityKg?: number;

    @ApiPropertyOptional({ example: 8.5 })
    @IsOptional()
    @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Capacity in m3 must be a number with at most 2 decimals.' })
    @IsPositive({ message: 'Capacity in m3 must be greater than zero.' })
    @Max(MAX_CAPACITY, { message: 'Capacity in m3 is too large.' })
    capacityM3?: number;

    @ApiPropertyOptional({ example: 2, description: 'Operational status ID (must exist in vehicle_statuses)' })
    @IsOptional()
    @IsInt({ message: 'Vehicle status ID must be an integer.' })
    @IsPositive({ message: 'Vehicle status ID must be a positive number.' })
    vehicleStatusId?: number;
}
