import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { INT4_MAX } from '../../../../shared/constants/int4.js';

// ISO-8601 with a time and an explicit offset: a bare local time would be read in the server's zone.
export const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
export const UTC_DATE_TIME_MESSAGE = 'must be an ISO-8601 date and time with an offset, e.g. 2026-10-20T14:00:00Z.';

export class SchedulePickupDto {
    @ApiPropertyOptional({
        type: 'integer', minimum: 1, maximum: INT4_MAX, example: 3,
        description: 'Optional vehicle preference for backward compatibility. When omitted, planning chooses a vehicle for the pickup route and checks the combined route capacity.',
    })
    @IsOptional()
    @IsInt({ message: 'vehicleId must be an integer.' })
    @Min(1, { message: 'vehicleId must be at least 1.' })
    @Max(INT4_MAX, { message: `vehicleId must not be greater than ${INT4_MAX}.` })
    vehicleId?: number;

    @ApiPropertyOptional({
        type: String, format: 'date-time', example: '2026-10-20T14:00:00Z',
        description: 'Start of the slot to agree with the supplier. Must be sent together with `windowEnd` and fall inside the intersection of the supplier schedule and the warehouse reception hours. When both are omitted, the earliest slot still ahead of that intersection is taken',
    })
    @IsOptional()
    @Matches(UTC_DATE_TIME, { message: `windowStart ${UTC_DATE_TIME_MESSAGE}` })
    @IsDateString({ strict: true }, { message: `windowStart ${UTC_DATE_TIME_MESSAGE}` })
    windowStart?: string;

    @ApiPropertyOptional({
        type: String, format: 'date-time', example: '2026-10-20T16:00:00Z',
        description: 'End of the slot to agree with the supplier. Must be sent together with `windowStart` and be later than it',
    })
    @IsOptional()
    @Matches(UTC_DATE_TIME, { message: `windowEnd ${UTC_DATE_TIME_MESSAGE}` })
    @IsDateString({ strict: true }, { message: `windowEnd ${UTC_DATE_TIME_MESSAGE}` })
    windowEnd?: string;
}
