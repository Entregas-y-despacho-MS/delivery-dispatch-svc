import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { INT4_MAX } from '../../../../shared/constants/int4.js';
import { UTC_DATE_TIME, UTC_DATE_TIME_MESSAGE } from './schedule-pickup.dto.js';

export class ReschedulePickupDto {
    @ApiProperty({
        type: 'integer', minimum: 1, maximum: INT4_MAX, example: 4,
        description: 'Id of the incident reason (catalog of incident reasons, RF-A32) that explains why the supplier did not have the load ready. Must exist and be active',
    })
    @IsInt({ message: 'incidentReasonId must be an integer.' })
    @Min(1, { message: 'incidentReasonId must be at least 1.' })
    @Max(INT4_MAX, { message: `incidentReasonId must not be greater than ${INT4_MAX}.` })
    incidentReasonId!: number;

    @ApiProperty({
        type: 'integer', minimum: 1, maximum: INT4_MAX, example: 6,
        description: 'Id of the reschedule reason (catalog of reschedule reasons, RF-A33) recorded in `dispatch_reschedules`. Must exist and be active',
    })
    @IsInt({ message: 'rescheduleReasonId must be an integer.' })
    @Min(1, { message: 'rescheduleReasonId must be at least 1.' })
    @Max(INT4_MAX, { message: `rescheduleReasonId must not be greater than ${INT4_MAX}.` })
    rescheduleReasonId!: number;

    @ApiProperty({
        type: String, format: 'date-time', example: '2026-10-21T14:00:00Z',
        description: 'Start of the new slot. It must be later than the current slot, start at most `reschedule_window_days` (ES-57) days after it, and fall inside the warehouse reception hours',
    })
    @Matches(UTC_DATE_TIME, { message: `windowStart ${UTC_DATE_TIME_MESSAGE}` })
    @IsDateString({ strict: true }, { message: `windowStart ${UTC_DATE_TIME_MESSAGE}` })
    windowStart!: string;

    @ApiProperty({
        type: String, format: 'date-time', example: '2026-10-21T16:00:00Z',
        description: 'End of the new slot; later than `windowStart` and on the same local day',
    })
    @Matches(UTC_DATE_TIME, { message: `windowEnd ${UTC_DATE_TIME_MESSAGE}` })
    @IsDateString({ strict: true }, { message: `windowEnd ${UTC_DATE_TIME_MESSAGE}` })
    windowEnd!: string;

    @ApiPropertyOptional({
        type: String, maxLength: 500, example: 'The supplier did not have the load ready at the agreed time',
        description: 'Free-text detail of the incident, stored with it. Omit it when there is nothing to add',
    })
    @IsOptional()
    @IsString({ message: 'description must be a string.' })
    @MaxLength(500, { message: 'description must not be longer than 500 characters.' })
    description?: string;
}
