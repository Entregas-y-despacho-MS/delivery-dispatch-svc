import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';

export class PendingOrderReservationDto {
    @ApiProperty({ type: 'integer', example: 5, description: 'ID of the coordinator planning this order' })
    reservedById!: number;

    @ApiProperty({ example: 'Ana Rojas', description: 'Full name of the coordinator planning this order (shown as "En planificación por [Nombre]")' })
    reservedByName!: string;

    @ApiProperty({ type: String, format: 'date-time', description: 'When the reservation lapses if the coordinator stays inactive' })
    expiresAt!: Date;

    @ApiProperty({ example: false, description: 'true when the reservation belongs to the authenticated coordinator (their own orders are not blocked for them)' })
    reservedByMe!: boolean;
}

@ApiExtraModels(PendingOrderReservationDto)
export class PendingOrderDto {
    @ApiProperty({ type: 'integer', example: 12, description: 'Dispatch ID' })
    id!: number;

    @ApiProperty({ example: 'SO-2026-00481', description: 'Order number in the origin system (N° de orden)' })
    orderNumber!: string;

    @ApiProperty({ type: String, nullable: true, example: 'DSP-2026-00012', description: 'Tracking code (código de guía). null if the order has none yet' })
    trackingCode!: string | null;

    @ApiProperty({ type: String, nullable: true, example: 'María Pérez', description: 'Recipient name. null if the origin did not send one' })
    recipient!: string | null;

    @ApiProperty({ type: String, nullable: true, example: '+591 70000000', description: 'Recipient phone. null if the origin did not send one' })
    recipientPhone!: string | null;

    @ApiProperty({ example: 'Av. Arce 2000, La Paz', description: 'Delivery address' })
    address!: string;

    @ApiProperty({ type: 'integer', nullable: true, example: 3, description: 'Delivery zone ID. null when the order has no zone' })
    zoneId!: number | null;

    @ApiProperty({ type: String, nullable: true, example: 'Zona Sur', description: 'Delivery zone name. null when the order has no zone' })
    zoneName!: string | null;

    @ApiProperty({ type: String, nullable: true, enum: ['morning', 'afternoon'], description: 'Shift of the agreed window (Bolivia time). null when the order has no window' })
    shift!: 'morning' | 'afternoon' | null;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'Start of the agreed delivery window (franja). null when there is none' })
    windowStart!: Date | null;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'End of the agreed delivery window. null when there is none' })
    windowEnd!: Date | null;

    @ApiProperty({ enum: ['urgent', 'normal'], description: 'Order priority' })
    priority!: string;

    @ApiProperty({ example: 'pending', description: 'Dispatch status. Shown as `in_planning` while a live reservation exists, whoever holds it' })
    status!: string;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'SLA deadline: creation time plus the target time of the service level. null when the order has no service level' })
    slaDueAt!: Date | null;

    @ApiProperty({ type: 'integer', example: 2, description: 'Number of packages (bultos)' })
    packagesCount!: number;

    @ApiProperty({ type: 'number', format: 'double', example: 12.5, minimum: 0, description: 'Total gross weight of the packages, in kg (0 when there are none)' })
    weightKg!: number;

    @ApiProperty({ type: 'number', format: 'double', example: 0.18, minimum: 0, description: 'Total volume of the packages, in m³ (length × width × height; 0 when there are none)' })
    volumeM3!: number;

    @ApiProperty({ example: false, description: 'true when another coordinator is planning this order: it must not be selectable' })
    locked!: boolean;

    @ApiProperty({ allOf: [{ $ref: getSchemaPath(PendingOrderReservationDto) }], nullable: true, description: 'The live soft reservation, or null when the order is free' })
    reservation!: PendingOrderReservationDto | null;
}

// The inbox answers { data, total, page, limit } as the ticket defines it, not the { data, meta } of the other lists.
export class FindPendingOrdersResponseDto {
    @ApiProperty({ type: [PendingOrderDto], description: 'Orders on the current page' })
    data!: PendingOrderDto[];

    @ApiProperty({ type: 'integer', example: 42, description: 'Total number of orders matching the filters' })
    total!: number;

    @ApiProperty({ type: 'integer', example: 1, description: 'Current page number' })
    page!: number;

    @ApiProperty({ type: 'integer', example: 10, description: 'Items per page' })
    limit!: number;
}
