import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsNumber, IsPositive, IsString, Max, MaxLength } from 'class-validator';
import { OptionalNotNull } from '../../../../shared/validators/optional-not-null.validator.js';

const MAX_CAPACITY = 99999999.99;

const normalizePlate = ({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value;

export class UpdateVehicleDto {
    @ApiPropertyOptional({ example: 'camioneta', maxLength: 50, description: 'New vehicle type. null or empty is rejected' })
    @OptionalNotNull()
    @IsString()
    @IsNotEmpty({ message: 'Type must not be empty.' })
    @MaxLength(50, { message: 'Type must not exceed 50 characters.' })
    type?: string;

    @ApiPropertyOptional({ example: 'Toyota Hilux 2022', maxLength: 100, description: 'New make and model. null or empty is rejected' })
    @OptionalNotNull()
    @IsString()
    @IsNotEmpty({ message: 'Model must not be empty.' })
    @MaxLength(100, { message: 'Model must not exceed 100 characters.' })
    model?: string;

    @ApiPropertyOptional({ example: '1234-ABC', maxLength: 15, description: 'New plate, trimmed and uppercased. Must not belong to another vehicle. null or empty is rejected' })
    @OptionalNotNull()
    @Transform(normalizePlate)
    @IsString()
    @IsNotEmpty({ message: 'Plate must not be empty.' })
    @MaxLength(15, { message: 'Plate must not exceed 15 characters.' })
    plate?: string;

    @ApiPropertyOptional({ type: 'number', format: 'double', example: 1200.5, exclusiveMinimum: true, minimum: 0, maximum: 99999999.99, description: 'New maximum load weight in kg (greater than zero, up to 2 decimals). null is rejected' })
    @OptionalNotNull()
    @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Capacity in kg must be a number with at most 2 decimals.' })
    @IsPositive({ message: 'Capacity in kg must be greater than zero.' })
    @Max(MAX_CAPACITY, { message: 'Capacity in kg is too large.' })
    capacityKg?: number;

    @ApiPropertyOptional({ type: 'number', format: 'double', example: 8.5, exclusiveMinimum: true, minimum: 0, maximum: 99999999.99, description: 'New maximum load volume in m3 (greater than zero, up to 2 decimals). null is rejected' })
    @OptionalNotNull()
    @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Capacity in m3 must be a number with at most 2 decimals.' })
    @IsPositive({ message: 'Capacity in m3 must be greater than zero.' })
    @Max(MAX_CAPACITY, { message: 'Capacity in m3 is too large.' })
    capacityM3?: number;

    @ApiPropertyOptional({ type: 'integer', example: 2, description: 'New operational status: 1 = active (available for routes), 2 = maintenance, 3 = out_of_service. Any other ID is a 400 INVALID_VEHICLE_STATUS. null is rejected' })
    @OptionalNotNull()
    @IsInt({ message: 'Vehicle status ID must be an integer.' })
    @IsPositive({ message: 'Vehicle status ID must be a positive number.' })
    vehicleStatusId?: number;
}
