import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsPositive, IsString, Max, MaxLength } from 'class-validator';

// NUMERIC(10,2) — 8 integer digits + 2 decimals.
const MAX_CAPACITY = 99999999.99;

// Plates are matched by exact value in the DB (partial unique index), so normalize at the door:
// " 1234-abc " and "1234-ABC" must be the same plate.
const normalizePlate = ({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CreateVehicleDto {
    @ApiProperty({ example: 'camioneta', maxLength: 50, description: 'Vehicle type (moto, camioneta, camión, etc.)' })
    @IsString()
    @IsNotEmpty({ message: 'Type is required.' })
    @MaxLength(50, { message: 'Type must not exceed 50 characters.' })
    type: string;

    @ApiProperty({ example: 'Toyota Hilux 2022', maxLength: 100 })
    @IsString()
    @IsNotEmpty({ message: 'Model is required.' })
    @MaxLength(100, { message: 'Model must not exceed 100 characters.' })
    model: string;

    @ApiProperty({ example: '1234-ABC', maxLength: 15, description: 'Unique plate — trimmed and uppercased before validation' })
    @Transform(normalizePlate)
    @IsString()
    @IsNotEmpty({ message: 'Plate is required.' })
    @MaxLength(15, { message: 'Plate must not exceed 15 characters.' })
    plate: string;

    @ApiProperty({ example: 1200.5, description: 'Maximum load weight in kg (greater than zero, up to 2 decimals)' })
    @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Capacity in kg must be a number with at most 2 decimals.' })
    @IsPositive({ message: 'Capacity in kg must be greater than zero.' })
    @Max(MAX_CAPACITY, { message: 'Capacity in kg is too large.' })
    capacityKg: number;

    @ApiProperty({ example: 8.5, description: 'Maximum load volume in m3 (greater than zero, up to 2 decimals)' })
    @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Capacity in m3 must be a number with at most 2 decimals.' })
    @IsPositive({ message: 'Capacity in m3 must be greater than zero.' })
    @Max(MAX_CAPACITY, { message: 'Capacity in m3 is too large.' })
    capacityM3: number;
}
