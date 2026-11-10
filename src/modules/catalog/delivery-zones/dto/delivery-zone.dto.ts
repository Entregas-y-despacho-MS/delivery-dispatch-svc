import { ApiProperty } from '@nestjs/swagger';
import { DtoField } from '../../../../shared/orm/index.js';
import { PolygonBoundary } from '../validators/polygon-boundary.validator.js';

export class DeliveryZoneDto {
    @DtoField()
    @ApiProperty({ type: 'integer', example: 1, description: 'Delivery zone ID' })
    id!: number;

    @DtoField()
    @ApiProperty({ example: 'ZON-SUR', description: 'Unique short code of the zone' })
    code!: string;

    @DtoField()
    @ApiProperty({ example: 'Zona Sur', description: 'Display name of the zone' })
    name!: string;

    @DtoField()
    @ApiProperty({ type: 'integer', example: 45, description: 'Base estimated delivery time in this zone, in minutes' })
    estimatedTimeMin!: number;

    @DtoField()
    @ApiProperty({
        type: 'array',
        nullable: true,
        items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        example: [[-68.15, -16.5], [-68.1, -16.5], [-68.1, -16.45], [-68.15, -16.45]],
        description: 'Coverage polygon as [longitude, latitude] pairs, or null if the zone has no geographic boundary.',
    })
    boundary!: PolygonBoundary | null;

    @DtoField()
    @ApiProperty({ type: String, format: 'date-time', example: '2024-01-01T00:00:00.000Z', description: 'Creation timestamp (UTC)' })
    createdAt!: Date;
}
