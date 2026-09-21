import { ApiProperty } from '@nestjs/swagger';
import { DtoField } from '../../../../shared/orm/index.js';

export class DeliveryZoneDto {
    @DtoField()
    @ApiProperty({ example: 1 })
    id!: number;

    @DtoField()
    @ApiProperty({ example: 'ZON-SUR' })
    code!: string;

    @DtoField()
    @ApiProperty({ example: 'Zona Sur' })
    name!: string;

    @DtoField()
    @ApiProperty({ example: 45, description: 'Tiempo base estimado de entrega, en minutos' })
    estimatedTimeMin!: number;

    @DtoField()
    @ApiProperty({ example: '2024-01-01T00:00:00.000Z' })
    createdAt!: Date;
}
