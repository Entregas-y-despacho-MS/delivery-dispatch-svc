import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsInt, IsLatitude, IsLongitude, IsPositive, Max } from 'class-validator';
import { INT4_MAX } from '../../../shared/constants/int4.js';

export class LocationPointDto {
    @ApiProperty({ type: 'integer', example: 42, description: 'ID of the dispatch this position belongs to — must be on a route assigned to the reporting driver' })
    @IsInt()
    @IsPositive()
    @Max(INT4_MAX)
    dispatchId: number;

    @ApiProperty({ example: -17.783, description: 'Latitude, decimal degrees (WGS84), between -90 and 90' })
    @IsLatitude()
    latitude: number;

    @ApiProperty({ example: -63.182, description: 'Longitude, decimal degrees (WGS84), between -180 and 180' })
    @IsLongitude()
    longitude: number;

    // The device's own UTC clock when the point was captured — not when it finally reached the
    // server. A buffered batch (RF-U11, Escenario 3) is applied in this order, oldest first, so an
    // older point never overwrites a newer one already reported.
    @ApiProperty({ example: '2026-09-29T14:03:00.000Z', description: 'When the device captured this point, ISO 8601 in UTC (not when it was sent)' })
    @IsDateString()
    recordedAt: string;
}
