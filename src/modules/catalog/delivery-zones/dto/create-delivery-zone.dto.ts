import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsPositive, IsString, Max, MaxLength } from 'class-validator';

// Same 30-day ceiling as a service level target time: only there to reject absurd values.
const MAX_ZONE_TIME_MIN = 43200;

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

    @ApiProperty({ type: 'integer', example: 45, minimum: 1, maximum: 43200, description: 'Base estimated delivery time in this zone, in minutes (a whole number from 1 to 43200)' })
    @IsInt({ message: 'Estimated time must be an integer.' })
    @IsPositive({ message: 'Estimated time must be a positive number.' })
    @Max(MAX_ZONE_TIME_MIN, { message: `Estimated time must not exceed ${MAX_ZONE_TIME_MIN} minutes.` })
    estimatedTimeMin: number;
}
