import { ApiProperty } from '@nestjs/swagger';

export class RescheduleDispatchResultDto {
    @ApiProperty({ type: 'integer', example: 42, description: 'Id of the rescheduled dispatch' })
    dispatchId!: number;

    @ApiProperty({ type: String, example: 'rescheduled', description: 'Status of the dispatch after the rescheduling; always `rescheduled`' })
    status!: string;

    @ApiProperty({ type: 'integer', example: 17, description: 'Id of the row written in `dispatch_reschedules`' })
    rescheduleId!: number;

    @ApiProperty({ type: 'integer', example: 5, description: 'Planning version of the dispatch after taking it out of its route' })
    version!: number;

    @ApiProperty({ type: String, format: 'date-time', example: '2026-10-21T13:00:00.000Z', description: 'Start of the new agreed slot' })
    windowStart!: string;

    @ApiProperty({ type: String, format: 'date-time', example: '2026-10-21T15:00:00.000Z', description: 'End of the new agreed slot' })
    windowEnd!: string;

    @ApiProperty({ type: String, enum: ['morning', 'afternoon'], example: 'morning', description: 'Shift of the new slot, derived from its start hour in Bolivia time' })
    shift!: string;

    @ApiProperty({ type: 'integer', example: 1, description: 'Delivery attempts already spent by the dispatch (not_delivered entries plus incidents that count as an attempt)' })
    attemptsUsed!: number;

    @ApiProperty({ type: 'integer', example: 3, description: 'Limit of delivery attempts (`max_delivery_attempts`)' })
    attemptsLimit!: number;
}
