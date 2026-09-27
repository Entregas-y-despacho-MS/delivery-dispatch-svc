import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { LocationPointDto } from './location-point.dto.js';

export class ReportLocationsDto {
    // Not required to arrive in order (unlike SyncEventsBatchDto) — the service sorts by recordedAt
    // itself before applying, since only the latest point per dispatch actually matters.
    @ApiProperty({ type: [LocationPointDto], minItems: 1, description: 'One or more GPS points captured while the route was active. Order does not matter — they are applied oldest-first regardless of how they are sent, so a buffered batch synced after regaining signal (RF-U11, Escenario 3) works the same as a single live point' })
    @IsArray()
    @ArrayMinSize(1)
    @ValidateNested({ each: true })
    @Type(() => LocationPointDto)
    locations: LocationPointDto[];
}
