import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';

// A nested object that can be null. `type: Dto, nullable: true` is published as a bare "object", so the
// schema is referenced with allOf instead (Swagger shows it as the DTO, nullable).
const NullableRef = (dto: new () => object, description: string) => applyDecorators(
    ApiExtraModels(dto),
    ApiPropertyOptional({ nullable: true, allOf: [{ $ref: getSchemaPath(dto) }], description }),
);

export class DispatchDetailRefDto {
    @ApiProperty({ type: 'integer', example: 1, description: 'Id of the catalog row' })
    id!: number;

    @ApiProperty({ type: String, example: 'delivery', description: 'Name of the catalog row' })
    name!: string;
}

export class DispatchDetailPackageDto {
    @ApiProperty({ type: 'integer', example: 10, description: 'Id of the package' })
    id!: number;

    @ApiProperty({ type: String, example: 'PKG-001', description: 'Package id in the origin system' })
    externalPackageId!: string;

    @ApiProperty({ type: 'number', format: 'double', example: 40, description: 'Length in centimetres' })
    lengthCm!: number;

    @ApiProperty({ type: 'number', format: 'double', example: 30, description: 'Width in centimetres' })
    widthCm!: number;

    @ApiProperty({ type: 'number', format: 'double', example: 20, description: 'Height in centimetres' })
    heightCm!: number;

    @ApiProperty({ type: 'number', format: 'double', example: 5.5, description: 'Gross weight in kilograms' })
    grossWeightKg!: number;

    @ApiProperty({ type: [String], example: ['fragile'], description: 'Handling conditions of the package' })
    handlingConditions!: string[];
}

export class DispatchDetailDestinationDto {
    @ApiProperty({ type: String, example: 'Av. Busch 123', description: 'Delivery address' })
    address!: string;

    @ApiPropertyOptional({ type: String, nullable: true, example: 'Next to the pharmacy', description: 'Reference to find the address; `null` if none' })
    reference!: string | null;

    @ApiPropertyOptional({ type: 'number', format: 'double', nullable: true, example: -16.5, description: 'Latitude of the destination; `null` if not geocoded' })
    latitude!: number | null;

    @ApiPropertyOptional({ type: 'number', format: 'double', nullable: true, example: -68.15, description: 'Longitude of the destination; `null` if not geocoded' })
    longitude!: number | null;

    @ApiPropertyOptional({ type: String, nullable: true, example: 'Ana Perez', description: 'Contact person at the destination; `null` if none' })
    contactName!: string | null;

    @ApiPropertyOptional({ type: String, nullable: true, example: '+59170000000', description: 'Contact phone; `null` if none' })
    contactPhone!: string | null;

    @NullableRef(DispatchDetailRefDto, 'Delivery zone; `null` when the dispatch type has none')
    zone!: DispatchDetailRefDto | null;
}

export class DispatchDetailUserDto {
    @ApiProperty({ type: 'integer', example: 7, description: 'Id of the user' })
    id!: number;

    @ApiProperty({ type: String, example: 'Juan Rojas', description: 'Full name of the user' })
    fullName!: string;
}

export class DispatchDetailVehicleDto {
    @ApiProperty({ type: 'integer', example: 3, description: 'Id of the vehicle' })
    id!: number;

    @ApiProperty({ type: String, example: 'ABC-123', description: 'Licence plate' })
    plate!: string;

    @ApiProperty({ type: String, example: 'van', description: 'Vehicle type' })
    type!: string;

    @ApiProperty({ type: String, example: 'Toyota Hiace', description: 'Vehicle model' })
    model!: string;
}

export class DispatchDetailRouteDto {
    @ApiProperty({ type: 'integer', example: 55, description: 'Id of the route batch the dispatch belongs to' })
    id!: number;

    @ApiProperty({ type: String, example: 'in_execution', description: 'Status of the route batch' })
    status!: string;

    @ApiProperty({ type: String, format: 'date', example: '2026-10-19', description: 'Shift date of the route' })
    shiftDate!: string;

    @ApiPropertyOptional({ type: 'integer', nullable: true, example: 2, description: 'Visit order of this dispatch within the route; `null` if not sequenced' })
    sequenceOrder!: number | null;

    @NullableRef(DispatchDetailUserDto, 'Driver of the route; `null` until assigned')
    driver!: DispatchDetailUserDto | null;

    @NullableRef(DispatchDetailVehicleDto, 'Vehicle of the route; `null` until assigned')
    vehicle!: DispatchDetailVehicleDto | null;
}

export class DispatchDetailEventDto {
    @ApiProperty({ type: 'integer', example: 301, description: 'Id of the event' })
    id!: number;

    @ApiProperty({ type: String, example: 'status_changed', description: 'Type of the event' })
    eventType!: string;

    @ApiPropertyOptional({ type: String, nullable: true, example: 'assigned to in_transit', description: 'Free-text detail of the event; `null` if none' })
    detail!: string | null;

    @ApiPropertyOptional({ type: String, nullable: true, example: 'in_transit', description: 'Dispatch status the event moved to, when the event is a status change; `null` otherwise' })
    status!: string | null;

    @ApiPropertyOptional({ type: String, nullable: true, example: 'customer_absent', description: 'Declared reason of the event; `null` if none' })
    reason!: string | null;

    @ApiProperty({ type: String, format: 'date-time', description: 'Moment the event happened (for events created offline, when it happened on the device)' })
    occurredAt!: string;

    @ApiPropertyOptional({ type: 'number', format: 'double', nullable: true, example: -16.5, description: 'Latitude where the event happened; `null` when the event did not record one' })
    latitude!: number | null;

    @ApiPropertyOptional({ type: 'number', format: 'double', nullable: true, example: -68.15, description: 'Longitude where the event happened; `null` when the event did not record one' })
    longitude!: number | null;

    @ApiPropertyOptional({ type: String, nullable: true, enum: ['user', 'system', 'customer'], description: 'Who originated the event; `null` for old events with no recorded author' })
    actorType!: string | null;

    @NullableRef(DispatchDetailUserDto, 'Operator who originated the event; `null` when it was the system, the customer or unknown')
    operator!: DispatchDetailUserDto | null;
}

export class DispatchDetailIncidentDto {
    @ApiProperty({ type: String, format: 'uuid', description: 'Id of the incident' })
    id!: string;

    @ApiProperty({ type: String, example: 'customer_absent', description: 'Code of the incident reason' })
    reasonCode!: string;

    @ApiProperty({ type: String, example: 'Customer absent', description: 'Name of the incident reason' })
    reasonName!: string;

    @ApiPropertyOptional({ type: String, nullable: true, description: 'Description written by the driver; `null` if none' })
    description!: string | null;

    @ApiProperty({ type: String, format: 'date-time', description: 'Moment the incident was registered' })
    occurredAt!: string;
}

export class DispatchDetailRescheduleDto {
    @ApiProperty({ type: 'integer', example: 12, description: 'Id of the reschedule' })
    id!: number;

    @ApiProperty({ type: String, example: 'customer_request', description: 'Code of the reschedule reason' })
    reasonCode!: string;

    @ApiProperty({ type: String, example: 'Customer request', description: 'Name of the reschedule reason' })
    reasonName!: string;

    @ApiProperty({ type: String, enum: ['customer', 'coordinator', 'system'], description: 'Who asked for the change' })
    rescheduledByType!: string;

    @NullableRef(DispatchDetailUserDto, 'User who made the change; `null` when it was the customer or the system')
    rescheduledBy!: DispatchDetailUserDto | null;

    @ApiPropertyOptional({ type: 'integer', nullable: true, description: 'Route batch before the change; `null` if there was none' })
    previousRouteBatchId!: number | null;

    @ApiPropertyOptional({ type: 'integer', nullable: true, description: 'Route batch after the change; `null` if there is none' })
    newRouteBatchId!: number | null;

    @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true, description: 'Delivery window start before the change' })
    previousWindowStart!: string | null;

    @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true, description: 'Delivery window end before the change' })
    previousWindowEnd!: string | null;

    @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true, description: 'Delivery window start after the change' })
    newWindowStart!: string | null;

    @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true, description: 'Delivery window end after the change' })
    newWindowEnd!: string | null;

    @ApiProperty({ type: String, format: 'date-time', description: 'Moment the change was made' })
    createdAt!: string;
}

export class DispatchDetailEvidenceDto {
    @ApiProperty({ type: String, format: 'uuid', description: 'Id of the evidence' })
    id!: string;

    @ApiProperty({ type: String, enum: ['photo', 'signature', 'otp'], description: 'Kind of evidence' })
    type!: string;

    @ApiPropertyOptional({ type: String, nullable: true, description: 'Short-lived signed URL to read the file; `null` for evidence with no file (an OTP). It stops working at `accessUrlExpiresAt`: ask the detail again for a new one. The stored file path is never returned' })
    accessUrl!: string | null;

    @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true, description: 'Moment `accessUrl` stops working; `null` when there is no URL' })
    accessUrlExpiresAt!: string | null;

    @ApiProperty({ type: String, format: 'date-time', description: 'Moment the evidence was captured (falls back to when it was registered if the device sent no capture time)' })
    capturedAt!: string;

    @ApiPropertyOptional({ type: 'number', format: 'double', nullable: true, description: 'Latitude of the capture; `null` if the device had none' })
    latitude!: number | null;

    @ApiPropertyOptional({ type: 'number', format: 'double', nullable: true, description: 'Longitude of the capture; `null` if the device had none' })
    longitude!: number | null;

    @ApiPropertyOptional({ type: String, nullable: true, description: 'Name of who received the order, for a signature; `null` otherwise' })
    receiverName!: string | null;

    @ApiPropertyOptional({ type: String, nullable: true, description: 'Document of who received the order, for a signature; `null` otherwise' })
    receiverDocument!: string | null;
}

export class DispatchDetailRatingDto {
    @ApiProperty({ type: 'integer', minimum: 1, maximum: 5, description: 'Customer rating for the delivery.' })
    score!: number;

    @ApiProperty({ type: String, nullable: true, maxLength: 500, description: 'Optional trimmed plain-text customer comment; null when omitted or blank.' })
    comment!: string | null;

    @ApiProperty({ type: String, format: 'date-time', description: 'When the customer submitted the rating.' })
    createdAt!: string;
}

export class DispatchDetailReceiptItemDto {
    @ApiProperty({ type: String, nullable: true, example: 'SKU-100', description: 'Product code in the origin system (RMA or supplier pickup); `null` when the item is a tracked package' })
    itemCode!: string | null;

    @ApiProperty({ type: 'integer', nullable: true, example: 10, description: 'Id of the tracked package (delivery); `null` when the item is identified by `itemCode`' })
    packageId!: number | null;

    @ApiProperty({ type: 'number', format: 'double', minimum: 0, example: 2, description: 'Quantity accepted in good condition' })
    acceptedQuantity!: number;

    @ApiProperty({ type: 'number', format: 'double', minimum: 0, example: 0, description: 'Quantity declared missing' })
    missingQuantity!: number;

    @ApiProperty({ type: 'number', format: 'double', minimum: 0, example: 1, description: 'Quantity received damaged' })
    damagedQuantity!: number;

    @ApiProperty({ type: String, nullable: true, example: 'Box crushed on one side', description: 'Free-text detail of the difference; `null` if none' })
    detail!: string | null;
}

export class DispatchDetailReceiptDto {
    @ApiProperty({ type: String, enum: ['complete', 'with_differences', 'rejected'], example: 'with_differences', description: 'Outcome of the warehouse receipt (the web shows Recibido, Con diferencias, Rechazado)' })
    result!: string;

    @ApiProperty({ type: String, format: 'date-time', example: '2026-11-09T15:00:00.000Z', description: 'When the warehouse physically received the goods' })
    receivedAt!: string;

    @ApiProperty({ type: String, nullable: true, example: 'One box arrived damaged', description: 'Free-text notes of the warehouse; `null` if none' })
    notes!: string | null;

    @ApiProperty({ type: [DispatchDetailReceiptItemDto], description: 'Items of the receipt. Empty when the warehouse sent no detail' })
    items!: DispatchDetailReceiptItemDto[];
}

export class DispatchDetailDto {
    @ApiProperty({ type: 'integer', example: 120, description: 'Id of the dispatch' })
    id!: number;

    @ApiPropertyOptional({ type: String, nullable: true, example: 'DSP-8H2K9Q', description: 'Public tracking code; `null` if not generated' })
    trackingCode!: string | null;

    @ApiProperty({ type: String, example: 'SO-1001', description: 'Order reference in the origin system' })
    sourceOrderRef!: string;

    @ApiProperty({ type: DispatchDetailRefDto, description: 'Type of the dispatch' })
    type!: DispatchDetailRefDto;

    @ApiProperty({ type: DispatchDetailRefDto, description: 'Current status of the dispatch' })
    status!: DispatchDetailRefDto;

    @ApiProperty({ type: String, enum: ['urgent', 'normal'], description: 'Priority of the dispatch' })
    priority!: string;

    @NullableRef(DispatchDetailRefDto, 'Service level; `null` if none')
    serviceLevel!: DispatchDetailRefDto | null;

    @ApiProperty({ type: String, example: 'hand_delivery_standard', description: 'Evidence policy the delivery had to meet' })
    evidencePolicy!: string;

    @ApiPropertyOptional({ type: String, nullable: true, example: 'Prepaid', description: 'Read-only payment label from the origin system; `null` if none' })
    paymentStatusLabel!: string | null;

    @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true, description: 'Start of the scheduled delivery window; `null` if not scheduled' })
    scheduledWindowStart!: string | null;

    @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true, description: 'End of the scheduled delivery window; `null` if not scheduled' })
    scheduledWindowEnd!: string | null;

    @ApiProperty({ type: String, format: 'date-time', description: 'Moment the dispatch was created' })
    createdAt!: string;

    @ApiProperty({ type: DispatchDetailDestinationDto, description: 'Destination of the dispatch' })
    destination!: DispatchDetailDestinationDto;

    @ApiProperty({ type: [DispatchDetailPackageDto], description: 'Packages of the dispatch' })
    packages!: DispatchDetailPackageDto[];

    @NullableRef(DispatchDetailRouteDto, 'Route, driver and vehicle; `null` while the dispatch is not assigned to a route')
    route!: DispatchDetailRouteDto | null;

    @NullableRef(DispatchDetailEvidenceDto, 'Signature evidence that carries the receiver, i.e. who got the order; `null` if nobody has signed')
    receiver!: DispatchDetailEvidenceDto | null;

    @NullableRef(DispatchDetailRatingDto, 'Customer opinion with stars, optional comment and date; `null` when the customer has not rated the delivery')
    rating!: DispatchDetailRatingDto | null;

    @NullableRef(DispatchDetailReceiptDto, 'Warehouse receipt of the goods (RMA or supplier pickup); `null` while the dispatch has none. Orphan receipts are not exposed')
    receipt!: DispatchDetailReceiptDto | null;

    @ApiProperty({ type: [DispatchDetailEventDto], description: 'Timeline, oldest first' })
    timeline!: DispatchDetailEventDto[];

    @ApiProperty({ type: [DispatchDetailIncidentDto], description: 'Incidents reported by the driver, oldest first' })
    incidents!: DispatchDetailIncidentDto[];

    @ApiProperty({ type: [DispatchDetailRescheduleDto], description: 'Reschedules and reassignments, oldest first' })
    reschedules!: DispatchDetailRescheduleDto[];

    @ApiProperty({ type: [DispatchDetailEvidenceDto], description: 'Delivery evidence (photos, signatures, OTP), oldest first. Empty when there is none' })
    evidences!: DispatchDetailEvidenceDto[];
}
