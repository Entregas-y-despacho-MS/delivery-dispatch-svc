import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { UTC_DATE_TIME, UTC_DATE_TIME_MESSAGE } from '../../../modules/dispatch/pickup-scheduling/dto/schedule-pickup.dto.js';

export class RescheduleDispatchDto {
    @ApiProperty({
        type: String, maxLength: 30, example: 'RES-OPS-ROUTE',
        description: 'Code of the reschedule reason (catalog of reschedule reasons, RF-A33). It must exist, be active and not be deleted',
    })
    @IsString({ message: 'reasonCode must be a string.' })
    @IsNotEmpty({ message: 'reasonCode must not be empty.' })
    @MaxLength(30, { message: 'reasonCode must not be longer than 30 characters.' })
    reasonCode!: string;

    @ApiProperty({
        type: String, format: 'date-time', example: '2026-10-21T13:00:00Z',
        description: 'Start of the new agreed delivery slot. Its local date (America/La_Paz) is the agreed date: it cannot be before today. Together with `windowEnd` it must be exactly one of the delivery slots (`morning_window_*` and `afternoon_window_*` cut every `slot_duration_minutes`); the shift is derived from its hour',
    })
    @Matches(UTC_DATE_TIME, { message: `windowStart ${UTC_DATE_TIME_MESSAGE}` })
    @IsDateString({ strict: true }, { message: `windowStart ${UTC_DATE_TIME_MESSAGE}` })
    windowStart!: string;

    @ApiProperty({
        type: String, format: 'date-time', example: '2026-10-21T15:00:00Z',
        description: 'End of the new agreed delivery slot; later than `windowStart` and on the same local day',
    })
    @Matches(UTC_DATE_TIME, { message: `windowEnd ${UTC_DATE_TIME_MESSAGE}` })
    @IsDateString({ strict: true }, { message: `windowEnd ${UTC_DATE_TIME_MESSAGE}` })
    windowEnd!: string;

    @ApiPropertyOptional({
        type: String, maxLength: 500, nullable: true, example: 'Call the customer 30 minutes before arriving.',
        description: 'Special instructions for the new attempt. They are kept in the audit event of the rescheduling; `null` or omitted means none',
    })
    @IsOptional()
    @IsString({ message: 'instructions must be a string.' })
    @MaxLength(500, { message: 'instructions must not be longer than 500 characters.' })
    instructions?: string | null;
}
