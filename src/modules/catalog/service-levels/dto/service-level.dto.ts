import { ApiProperty } from '@nestjs/swagger';
import { DtoField } from '../../../../shared/orm/index.js';

export class ServiceLevelDto {
    @DtoField()
    @ApiProperty({ example: 1 })
    id!: number;

    @DtoField()
    @ApiProperty({ example: 'Express 2 Horas' })
    name!: string;

    @DtoField()
    @ApiProperty({ example: 'Entrega prioritaria en 2 horas', nullable: true })
    description!: string | null;

    @DtoField()
    @ApiProperty({ example: 120, description: 'Target delivery time (SLA), in minutes' })
    targetTimeMin!: number;

    @DtoField()
    @ApiProperty({ example: 1, description: 'Priority hierarchy: 1 is the highest' })
    priorityLevel!: number;

    @DtoField()
    @ApiProperty({ example: true, description: 'false = disabled: cannot be assigned to new orders' })
    active!: boolean;

    @DtoField()
    @ApiProperty({ example: '2024-01-01T00:00:00.000Z' })
    createdAt!: Date;
}
