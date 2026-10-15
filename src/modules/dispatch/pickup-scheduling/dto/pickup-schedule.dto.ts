import { ApiProperty } from '@nestjs/swagger';

export class PickupWindowDto {
    @ApiProperty({ type: String, format: 'date-time', example: '2026-10-20T14:00:00.000Z', description: 'Start of the pickup window (ISO-8601, UTC)' })
    startsAt!: string;

    @ApiProperty({ type: String, format: 'date-time', example: '2026-10-20T16:00:00.000Z', description: 'End of the pickup window (ISO-8601, UTC)' })
    endsAt!: string;
}

export class PickupScheduleDto {
    @ApiProperty({ type: 'integer', example: 120, description: 'Id of the supplier pickup dispatch' })
    id!: number;

    @ApiProperty({ type: String, example: 'scheduled', description: 'Status of the dispatch after the operation (always `scheduled`)' })
    status!: string;

    @ApiProperty({ type: String, example: 'DSP-2026-00051', description: 'Transfer code of the dispatch; assigned the first time the pickup is scheduled and never changes afterwards' })
    trackingCode!: string;

    @ApiProperty({ type: 'integer', minimum: 1, example: 1, description: 'recordVersion of the `dispatch.pickup.scheduled` message published to Compras; grows with every scheduling or rescheduling of the pickup' })
    recordVersion!: number;

    @ApiProperty({ type: () => PickupWindowDto, description: 'Date and time slot agreed for the pickup, the one published to Compras' })
    pickupWindow!: PickupWindowDto;
}

export class PickupRescheduleDto extends PickupScheduleDto {
    @ApiProperty({ type: String, format: 'uuid', example: '0192fcf6-0000-7000-8000-000000000001', description: 'Id (UUID v7) of the incident recorded for the supplier unavailability; the same id is published in `dispatch.transfer.incident_reported`' })
    incidentId!: string;

    @ApiProperty({ type: () => PickupWindowDto, description: 'Slot the pickup had before it was rescheduled' })
    previousWindow!: PickupWindowDto;
}
