import { ApiProperty } from '@nestjs/swagger';

export class SlotDto {
    @ApiProperty({ description: 'Identifier of this slot. Send it back as `slotId` to choose it. It is only meaningful for this delivery and a short time: the choice is checked again when it is made.' })
    slotId!: string;

    @ApiProperty({ type: String, format: 'date', description: 'Local date of the delivery in this slot (`YYYY-MM-DD`).' })
    deliveryDate!: string;

    @ApiProperty({ type: String, format: 'date-time', description: 'Start of the delivery slot.' })
    windowStart!: Date;

    @ApiProperty({ type: String, format: 'date-time', description: 'End of the delivery slot.' })
    windowEnd!: Date;
}

export class AvailableSlotsDto {
    @ApiProperty({ type: () => [SlotDto], description: 'Slots the delivery can move to, earliest first, one per date and time. Empty when there is none.' })
    slots!: SlotDto[];

    @ApiProperty({
        type: String, nullable: true, enum: ['no_slots', 'planning_not_configured', 'no_location'],
        description: 'Why `slots` is empty; `null` when it is not. `no_slots`: no open batch of the zone can take it. `planning_not_configured` and `no_location`: it cannot be checked now. In every case the page tells the customer to contact Dispatch and offers the change request.',
    })
    unavailableReason!: 'no_slots' | 'planning_not_configured' | 'no_location' | null;
}
