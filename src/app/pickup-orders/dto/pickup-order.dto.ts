import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';

export class PickupOrderWarehouseDto {
    @ApiProperty({ type: 'integer', example: 3, description: 'Id of the destination warehouse' })
    id!: number;

    @ApiProperty({ type: String, example: 'WH-LPZ-01', description: 'Code of the destination warehouse' })
    code!: string;

    @ApiProperty({ type: String, example: 'Central warehouse La Paz', description: 'Name of the destination warehouse' })
    name!: string;
}

/** A customer pickup order (`dispatch_type = warehouse_return_pickup`), as the Recojos page reads it. */
@ApiExtraModels(PickupOrderWarehouseDto)
export class PickupOrderDto {
    @ApiProperty({ type: 'integer', example: 42, description: 'Id of the dispatch' })
    id!: number;

    @ApiProperty({ type: String, nullable: true, example: 'DSP-2026-00042', description: 'Transfer code of the pickup; `null` only for an RMA received before codes were assigned to pickups' })
    trackingCode!: string | null;

    @ApiProperty({ type: String, example: 'MANUAL-DSP-2026-00042', description: 'Reference of the order in its origin: the RMA id for an RMA, `MANUAL-<transfer code>` for an order the coordinator registered' })
    sourceOrderRef!: string;

    @ApiProperty({ type: String, enum: ['manual', 'rma'], example: 'manual', description: 'How the order was created: `manual` (the coordinator registered it) or `rma` (Almacén sent it in `inventory.return.requested`)' })
    origin!: 'manual' | 'rma';

    @ApiProperty({ type: String, example: 'pickup_scheduled', description: 'Current status of the dispatch (`pickup_scheduled`, `address_review`, `in_planning`, `assigned`, `cancelled`...)' })
    status!: string;

    @ApiProperty({ type: String, nullable: true, example: 'María Fernández Quispe', description: 'Name of the customer; `null` if none was given' })
    contactName!: string | null;

    @ApiProperty({ type: String, nullable: true, example: '+59171234567', description: 'Phone of the customer; `null` if none was given' })
    contactPhone!: string | null;

    @ApiProperty({ type: String, nullable: true, example: 'maria.fernandez@example.com', description: 'Email of the customer; `null` if none was given' })
    contactEmail!: string | null;

    @ApiProperty({ type: String, example: 'Calle 21 de Calacoto 8790, casa 12', description: 'Address where the goods are picked up' })
    address!: string;

    @ApiProperty({ type: String, nullable: true, example: 'Condominio Las Palmas, segunda garita', description: 'Extra directions to find the address; `null` if none' })
    reference!: string | null;

    @ApiProperty({ type: 'number', format: 'double', minimum: -90, maximum: 90, nullable: true, example: -16.5421, description: 'Latitude of the pickup point; `null` for an RMA without coordinates (`address_review`)' })
    latitude!: number | null;

    @ApiProperty({ type: 'number', format: 'double', minimum: -180, maximum: 180, nullable: true, example: -68.0802, description: 'Longitude of the pickup point; `null` for an RMA without coordinates (`address_review`)' })
    longitude!: number | null;

    @ApiProperty({ type: String, nullable: true, example: 'Product with a power failure, within warranty', description: 'Why the goods are returned; `null` if none was given' })
    returnReason!: string | null;

    @ApiProperty({ type: String, nullable: true, example: '1 notebook with its charger', description: 'Description of the goods; `null` for an RMA, which brings packages instead of a description' })
    packageContents!: string | null;

    @ApiProperty({ type: 'integer', nullable: true, example: 1, description: 'Estimated number of boxes; `null` if not estimated' })
    estimatedBoxes!: number | null;

    @ApiProperty({ type: String, format: 'date', nullable: true, example: '2026-11-10', description: 'Day the pickup is preferred on (Bolivia, `YYYY-MM-DD`); `null` if there is none' })
    preferredPickupDate!: string | null;

    @ApiProperty({ allOf: [{ $ref: getSchemaPath(PickupOrderWarehouseDto) }], nullable: true, description: 'Warehouse that receives the goods; `null` if none is set' })
    destinationWarehouse!: PickupOrderWarehouseDto | null;

    @ApiProperty({ type: String, format: 'date-time', example: '2026-11-06T15:00:00.000Z', description: 'When the order was created' })
    createdAt!: string;

    @ApiProperty({ type: String, enum: ['complete', 'with_differences', 'rejected'], nullable: true, example: 'with_differences', description: 'Outcome of the warehouse receipt of the goods (the web shows Recibido, Con diferencias, Rechazado); `null` while the warehouse has not confirmed one' })
    receiptResult!: 'complete' | 'with_differences' | 'rejected' | null;
}
