import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';

export class DispatchKanbanTypeDto {
    @ApiProperty({ description: 'Dispatch type identifier.' }) id: number;
    @ApiProperty({ description: 'Display name of the dispatch type.' }) name: string;
}

export class DispatchKanbanZoneDto {
    @ApiProperty({ description: 'Delivery zone identifier.' }) id: number;
    @ApiProperty({ description: 'Display name of the delivery zone.' }) name: string;
}

export class DispatchKanbanDriverDto {
    @ApiProperty({ description: 'Driver user identifier.' }) id: number;
    @ApiProperty({ description: 'Driver full name.' }) fullName: string;
}

export class DispatchKanbanVehicleDto {
    @ApiProperty({ description: 'Vehicle identifier.' }) id: number;
    @ApiProperty({ description: 'Vehicle registration plate.' }) plate: string;
}

export class DispatchKanbanRouteBatchDto {
    @ApiProperty({ description: 'Route batch identifier.' }) id: number;
    @ApiProperty({ description: 'Current route batch status.' }) status: string;
}

export class DispatchKanbanReservationDto {
    @ApiProperty({ description: 'User identifier holding the reservation.' }) reservedById: number;
    @ApiProperty({ description: 'Display name of the user holding the reservation.' }) reservedByName: string;
    @ApiProperty({ type: String, format: 'date-time', description: 'Reservation expiration timestamp.' }) expiresAt: Date;
    @ApiProperty({ description: 'Whether the authenticated user holds this reservation.' }) reservedByMe: boolean;
}

@ApiExtraModels(DispatchKanbanTypeDto, DispatchKanbanZoneDto, DispatchKanbanDriverDto, DispatchKanbanVehicleDto, DispatchKanbanRouteBatchDto, DispatchKanbanReservationDto)
export class DispatchKanbanItemDto {
    @ApiProperty({ description: 'Dispatch identifier.' }) id: number;
    @ApiProperty({ description: 'Source order reference.' }) sourceOrderRef: string;
    @ApiProperty({ type: String, nullable: true, description: 'Public tracking code, if one has been assigned.' }) trackingCode: string | null;
    @ApiProperty({ description: 'Current dispatch status code.' }) status: string;
    @ApiProperty({ type: DispatchKanbanTypeDto, description: 'Dispatch type.' }) dispatchType: DispatchKanbanTypeDto;
    @ApiProperty({ nullable: true, oneOf: [{ $ref: getSchemaPath(DispatchKanbanZoneDto) }], description: 'Delivery zone, when assigned.' }) zone: DispatchKanbanZoneDto | null;
    @ApiProperty({ nullable: true, oneOf: [{ $ref: getSchemaPath(DispatchKanbanDriverDto) }], description: 'Assigned driver, when assigned.' }) driver: DispatchKanbanDriverDto | null;
    @ApiProperty({ nullable: true, oneOf: [{ $ref: getSchemaPath(DispatchKanbanVehicleDto) }], description: 'Assigned vehicle, when assigned.' }) vehicle: DispatchKanbanVehicleDto | null;
    @ApiProperty({ nullable: true, type: String, format: 'date-time', description: 'Start of the committed delivery window.' }) windowStart: Date | null;
    @ApiProperty({ nullable: true, type: String, format: 'date-time', description: 'End of the committed delivery window.' }) windowEnd: Date | null;
    @ApiProperty({ description: 'Dispatch priority.' }) priority: string;
    @ApiProperty({ description: 'Estimated order volume in cubic metres.' }) volumeM3: number;
    @ApiProperty({ description: 'Number of delivery attempts already consumed.' }) attemptCount: number;
    @ApiProperty({ description: 'Maximum number of delivery attempts.' }) attemptLimit: number;
    @ApiProperty({ nullable: true, oneOf: [{ $ref: getSchemaPath(DispatchKanbanRouteBatchDto) }], description: 'Route batch, when the dispatch belongs to one.' }) routeBatch: DispatchKanbanRouteBatchDto | null;
    @ApiProperty({ nullable: true, enum: ['proposed', 'reserved'], description: 'Inbox state for dispatches awaiting route planning.' }) inbox: 'proposed' | 'reserved' | null;
    @ApiProperty({ nullable: true, oneOf: [{ $ref: getSchemaPath(DispatchKanbanReservationDto) }], description: 'Reservation details when held by a planner.' }) reservation: DispatchKanbanReservationDto | null;
}

export class DispatchKanbanColumnDto {
    @ApiProperty({ description: 'Stable column key.' }) key: string;
    @ApiProperty({ type: [String], description: 'Dispatch status codes represented by this column.' }) statuses: string[];
    @ApiProperty({ description: 'Human-readable column label.' }) label: string;
    @ApiProperty({ description: 'Number of dispatches in this column.' }) ordersCount: number;
    @ApiProperty({ description: 'Total estimated volume in cubic metres for this column.' }) volumeM3: number;
    @ApiProperty({ type: [DispatchKanbanItemDto], description: 'Dispatch cards in this column.' }) dispatches: DispatchKanbanItemDto[];
}

export class DispatchKanbanResponseDto {
    @ApiProperty({ type: String, format: 'date', description: 'Operating date shown by the board.' }) date: string;
    @ApiProperty({ type: [DispatchKanbanColumnDto], description: 'Operational kanban columns and their dispatch cards.' }) columns: DispatchKanbanColumnDto[];
}
