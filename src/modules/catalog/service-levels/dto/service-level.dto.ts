import { ApiProperty } from '@nestjs/swagger';
import { DtoField } from '../../../../shared/orm/index.js';

export class ServiceLevelDto {
    @DtoField()
    @ApiProperty({ type: 'integer', example: 1, description: 'Service level ID' })
    id!: number;

    @DtoField()
    @ApiProperty({ example: 'Express 2 Horas', description: 'Unique name among the levels that have not been deleted' })
    name!: string;

    @DtoField()
    @ApiProperty({ type: String, example: 'Entrega prioritaria en 2 horas', nullable: true, description: 'Free-text description. null when none was given' })
    description!: string | null;

    @DtoField()
    @ApiProperty({ type: 'integer', example: 120, description: 'Target delivery time (SLA), in minutes' })
    targetTimeMin!: number;

    @DtoField()
    @ApiProperty({ type: 'integer', example: 1, description: 'Priority hierarchy: 1 is the highest. Different levels may share a value; the list breaks ties by target time' })
    priorityLevel!: number;

    @DtoField()
    @ApiProperty({ example: true, description: 'false = disabled: cannot be assigned to new orders' })
    active!: boolean;

    @DtoField()
    @ApiProperty({ type: String, format: 'date-time', example: '2024-01-01T00:00:00.000Z', description: 'Creation timestamp (UTC)' })
    createdAt!: Date;
}
