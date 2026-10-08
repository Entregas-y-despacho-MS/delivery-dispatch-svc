import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { DtoField, DtoRelation } from '../../../../shared/orm/index.js';

const toNumberOrNull = ({ value }: { value: unknown }) => (value === null || value === undefined ? null : Number(value));

export class AssignmentStatusDto {
    @DtoField()
    @ApiProperty({ type: 'integer', example: 2, description: 'Status ID' })
    id!: number;

    @DtoField()
    @ApiProperty({ example: 'in_transit', description: 'Status name, as stored in the dispatch_statuses catalog (pending, in_transit, delivered, not_delivered, returned)' })
    name!: string;
}

export class AssignmentServiceLevelDto {
    @DtoField()
    @ApiProperty({ type: 'integer', example: 1, description: 'Service level ID' })
    id!: number;

    @DtoField()
    @ApiProperty({ example: 'express', description: 'Service level name (e.g. standard, express)' })
    name!: string;
}

/** One stop of the driver's route for the day (RF-U02). */
@ApiExtraModels(AssignmentServiceLevelDto)
export class DriverAssignmentDto {
    @DtoField()
    @ApiProperty({ type: 'integer', example: 42, description: 'Dispatch ID' })
    id!: number;

    @DtoField()
    @ApiProperty({ type: 'integer', nullable: true, example: 1, description: 'Visit order of this stop within the route (1 = first stop). The driver follows this order and cannot change it. `null` only if the route has not been numbered yet' })
    sequenceOrder!: number | null;

    @DtoField()
    @ApiProperty({ example: 'SO-2026-000123', description: 'Order reference in the origin system (guide code shown to the driver until the transfer tracking code exists)' })
    sourceOrderRef!: string;

    @DtoField()
    @ApiProperty({ example: 'normal', enum: ['normal', 'urgent'], description: 'Dispatch priority' })
    priority!: string;

    @DtoField()
    @ApiProperty({ example: 'Av. Arce 2345, edificio Sol, piso 3', description: 'Delivery address' })
    deliveryAddress!: string;

    @DtoField()
    @Transform(toNumberOrNull)
    @ApiProperty({ type: 'number', format: 'double', nullable: true, example: -16.5, description: 'Destination latitude (WGS84). `null` when the origin did not send coordinates' })
    deliveryLatitude!: number | null;

    @DtoField()
    @Transform(toNumberOrNull)
    @ApiProperty({ type: 'number', format: 'double', nullable: true, example: -68.15, description: 'Destination longitude (WGS84). `null` when the origin did not send coordinates' })
    deliveryLongitude!: number | null;

    @DtoField()
    @ApiProperty({ type: String, nullable: true, example: 'Maria Lopez', description: 'Contact person at the destination' })
    contactName!: string | null;

    @DtoField()
    @ApiProperty({ type: String, nullable: true, example: '+59170000000', description: 'Contact phone number' })
    contactPhone!: string | null;

    @DtoField()
    @ApiProperty({ type: String, nullable: true, example: 'Prepaid', description: 'Read-only payment label from the origin system. Despachos does not manage payments' })
    paymentStatusLabel!: string | null;

    @DtoField()
    @ApiProperty({ type: String, nullable: true, example: '2 boxes: kitchen appliances', description: 'Read-only summary of the package contents' })
    packageContents!: string | null;

    @DtoField()
    @Transform(toNumberOrNull)
    @ApiProperty({ type: 'number', format: 'double', nullable: true, example: 12.5, description: 'Estimated cargo weight, in kg' })
    estimatedWeightKg!: number | null;

    @DtoField()
    @ApiProperty({ type: String, format: 'date-time', nullable: true, example: '2026-10-14T14:00:00.000Z', description: 'Start of the delivery window promised to the customer (UTC)' })
    scheduledWindowStart!: Date | null;

    @DtoField()
    @ApiProperty({ type: String, format: 'date-time', nullable: true, example: '2026-10-14T16:00:00.000Z', description: 'End of the delivery window promised to the customer (UTC)' })
    scheduledWindowEnd!: Date | null;

    @DtoRelation(() => AssignmentStatusDto)
    @ApiProperty({ type: () => AssignmentStatusDto, description: 'Current dispatch status' })
    dispatchStatus!: AssignmentStatusDto;

    @DtoRelation(() => AssignmentServiceLevelDto)
    @ApiProperty({ allOf: [{ $ref: getSchemaPath(AssignmentServiceLevelDto) }], nullable: true, description: 'Contracted service level. `null` when the dispatch has none' })
    serviceLevel!: AssignmentServiceLevelDto | null;

    @DtoField()
    @ApiProperty({ type: String, format: 'date-time', example: '2026-10-14T13:20:00.000Z', description: 'Last time this dispatch changed (UTC)' })
    updatedAt!: Date;
}
