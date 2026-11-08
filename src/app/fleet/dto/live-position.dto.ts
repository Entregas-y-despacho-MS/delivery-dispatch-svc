import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { DispatchDetailRefDto } from '../../../modules/dispatch/dispatches/dto/dispatch-detail.dto.js';

// A nested object that can be null. `type: Dto, nullable: true` is published as a bare "object", so the
// schema is referenced with allOf instead (Swagger shows it as the DTO, nullable).
const NullableRef = (dto: new () => object, description: string) => applyDecorators(
    ApiExtraModels(dto),
    ApiPropertyOptional({ nullable: true, allOf: [{ $ref: getSchemaPath(dto) }], description }),
);

export class FleetCurrentStopDto {
    @ApiProperty({ type: 'integer', example: 120, description: 'Id of the dispatch currently being worked on this route' })
    dispatchId!: number;

    @ApiProperty({ type: String, nullable: true, example: 'DSP-2026-00042', description: 'Tracking code of the current stop; `null` if it has none yet' })
    trackingCode!: string | null;

    @ApiProperty({ type: String, example: 'in_transit', description: 'Status of the current stop — `in_transit` while the driver is en route to it, otherwise the next open stop by visit order' })
    status!: string;
}

export class FleetLivePositionDto {
    @ApiProperty({ type: 'integer', example: 93, description: 'Id of the route batch (in execution)' })
    routeBatchId!: number;

    @ApiProperty({ type: 'integer', example: 10, description: 'Id of the driver assigned to this route' })
    driverId!: number;

    @ApiProperty({ type: String, example: 'Juan Pérez', description: 'Full name of the driver assigned to this route' })
    driverFullName!: string;

    @ApiProperty({ type: 'integer', example: 7, description: 'Id of the vehicle assigned to this route' })
    vehicleId!: number;

    @ApiProperty({ type: String, example: 'ABC-123', description: 'Plate of the vehicle assigned to this route' })
    vehiclePlate!: string;

    @NullableRef(DispatchDetailRefDto, 'Delivery zone of this route batch; `null` on a manual batch created before zone planning existed')
    deliveryZone!: DispatchDetailRefDto | null;

    @NullableRef(FleetCurrentStopDto, 'Stop the driver is currently working on, or the next open one if none is `in_transit`; `null` if the batch has no open stop left (it should close shortly)')
    currentStop!: FleetCurrentStopDto | null;

    @ApiProperty({ type: 'number', format: 'double', nullable: true, minimum: -90, maximum: 90, example: -17.783, description: 'Latitude of the last GPS point reported for this route; `null` if none was reported yet' })
    lastLatitude!: number | null;

    @ApiProperty({ type: 'number', format: 'double', nullable: true, minimum: -180, maximum: 180, example: -63.182, description: 'Longitude of the last GPS point reported for this route; `null` if none was reported yet' })
    lastLongitude!: number | null;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'When the last GPS point was reported; `null` if none was reported yet. Compare against the `gps_stale_alert_minutes` setting to tell a stale vehicle apart' })
    lastLocationAt!: string | null;
}
