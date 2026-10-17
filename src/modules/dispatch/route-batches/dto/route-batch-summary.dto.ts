import { ApiExtraModels, ApiProperty } from '@nestjs/swagger';
import { nullableRef } from './nullable-ref.js';

export class RouteBatchZoneDto {
    @ApiProperty({ type: 'integer', example: 3, description: 'Id of the delivery zone' })
    id!: number;

    @ApiProperty({ type: String, example: 'ACH', description: 'Code of the delivery zone' })
    code!: string;

    @ApiProperty({ type: String, example: 'Achumani', description: 'Name of the delivery zone' })
    name!: string;
}

export class RouteBatchVehicleDto {
    @ApiProperty({ type: 'integer', example: 8, description: 'Id of the vehicle' })
    id!: number;

    @ApiProperty({ type: String, example: '1234ABC', description: 'Plate of the vehicle' })
    plate!: string;

    @ApiProperty({ type: String, example: 'Hilux', description: 'Model of the vehicle' })
    model!: string;

    @ApiProperty({ type: String, example: 'pickup', description: 'Type of the vehicle' })
    type!: string;
}

export class RouteBatchUserDto {
    @ApiProperty({ type: 'integer', example: 12, description: 'Id of the user' })
    id!: number;

    @ApiProperty({ type: String, example: 'Maria Lopez', description: 'Full name of the user' })
    fullName!: string;
}

class OccupancyMeasureDto {
    @ApiProperty({ type: 'number', format: 'double', example: 820.5, description: 'Measured load in kilograms (weight) or cubic meters (volume)' })
    actual!: number;

    @ApiProperty({ type: 'number', format: 'double', example: 1000, description: 'Vehicle capacity in the same unit' })
    capacity!: number;

    @ApiProperty({ type: 'number', format: 'double', example: 82.05, description: 'Share of the vehicle capacity used, as a percentage' })
    usedPercent!: number;
}

export class RouteBatchOccupancyDto {
    @ApiProperty({ type: () => OccupancyMeasureDto, description: 'Total weight against the vehicle capacity' })
    weight!: OccupancyMeasureDto;

    @ApiProperty({ type: () => OccupancyMeasureDto, description: 'Total volume against the vehicle capacity' })
    volume!: OccupancyMeasureDto;

    @ApiProperty({ type: 'integer', isArray: true, example: [31], description: 'Dispatches whose weight is an estimate because they have no registered packages yet; their volume counts as zero' })
    estimatedDispatchIds!: number[];

    @ApiProperty({ type: Boolean, example: true, description: 'Whether the load fits the vehicle (weight, volume and package dimensions)' })
    assignable!: boolean;
}

@ApiExtraModels(RouteBatchZoneDto, RouteBatchVehicleDto, RouteBatchUserDto, RouteBatchOccupancyDto)
export class RouteBatchSummaryDto {
    @ApiProperty({ type: 'integer', example: 40, description: 'Id of the route batch' })
    id!: number;

    @ApiProperty({ type: String, example: 'provisional', description: 'Status of the batch: provisional, pending_final_review, confirmed, in_execution, closed or cancelled' })
    status!: string;

    @ApiProperty({ type: 'integer', example: 2, description: 'Planning version of the batch. Send it back as the expected version when approving' })
    version!: number;

    @ApiProperty({ type: String, format: 'date', example: '2026-10-17', description: 'Shift date of the batch (YYYY-MM-DD)' })
    shiftDate!: string;

    @ApiProperty({ ...nullableRef(RouteBatchZoneDto), description: 'Delivery zone of the batch; null when it has none' })
    zone!: RouteBatchZoneDto | null;

    @ApiProperty({ ...nullableRef(RouteBatchVehicleDto), description: 'Vehicle assigned or proposed; null while the batch has none (approving the promises requires one)' })
    vehicle!: RouteBatchVehicleDto | null;

    @ApiProperty({ ...nullableRef(RouteBatchUserDto), description: 'Driver proposed for the batch (`proposed_driver_id`); null when none' })
    proposedDriver!: RouteBatchUserDto | null;

    @ApiProperty({ ...nullableRef(RouteBatchUserDto), description: 'Reviewer of the batch; null when it has none and every coordinator can see it' })
    reviewer!: RouteBatchUserDto | null;

    @ApiProperty({ type: 'integer', example: 6, description: 'Number of dispatches currently in the batch' })
    dispatchCount!: number;

    @ApiProperty({ ...nullableRef(RouteBatchOccupancyDto), description: 'Weight and volume occupancy of the vehicle; null when the batch has no vehicle' })
    occupancy!: RouteBatchOccupancyDto | null;
}
