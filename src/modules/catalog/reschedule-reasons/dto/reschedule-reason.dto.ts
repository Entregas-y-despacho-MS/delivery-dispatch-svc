import { ApiProperty } from '@nestjs/swagger';
import { DtoField } from '../../../../shared/orm/index.js';
import { RescheduleReasonCategoryEnum } from '../../../../shared/enums/index.js';

export class RescheduleReasonDto {
    @DtoField()
    @ApiProperty({ type: 'integer', example: 1, description: 'Reschedule reason ID. Use it as `rescheduleReasonId` when recording a dispatch reschedule/reassignment' })
    id!: number;

    @DtoField()
    @ApiProperty({ example: 'Solicitud expresa del cliente', description: 'Display name shown in the reschedule/reassignment modal of the operations panel. Must not belong to another reason' })
    name!: string;

    @DtoField()
    @ApiProperty({ type: String, example: 'El cliente pidió mover la entrega a la tarde', nullable: true, description: 'Optional free-text detail. null when none was given' })
    description!: string | null;

    @DtoField()
    @ApiProperty({ enum: RescheduleReasonCategoryEnum, example: RescheduleReasonCategoryEnum.CLIENT, description: 'Who/what the delay is attributed to. client: the reschedule does not count against the team\'s internal punctuality metric · operations: an internal operational cause (e.g. route replanning) · force_majeure: outside anyone\'s control (e.g. a mechanical breakdown, weather)' })
    category!: RescheduleReasonCategoryEnum;

    @DtoField()
    @ApiProperty({ example: true, description: 'false = disabled: cannot be assigned to new reschedules/reassignments. Reschedules already logged with it are not affected' })
    active!: boolean;

    @DtoField()
    @ApiProperty({ type: String, format: 'date-time', example: '2024-01-01T00:00:00.000Z', description: 'Creation timestamp (UTC)' })
    createdAt!: Date;
}
