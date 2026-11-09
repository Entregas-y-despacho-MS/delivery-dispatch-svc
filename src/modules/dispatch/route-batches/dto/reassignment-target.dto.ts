import { ApiProperty } from '@nestjs/swagger';

export class ReassignmentTargetDto {
    @ApiProperty({ example: 55, description: 'Route batch ID — use it as targetBatchId in POST /route-batches/:id/reassign.' })
    routeBatchId!: number;

    @ApiProperty({ example: 12, description: 'Current version — use it as targetVersion in POST /route-batches/:id/reassign.' })
    version!: number;

    @ApiProperty({ example: 7, description: 'Driver of this route batch.' })
    driverId!: number;

    @ApiProperty({ example: 'Juan Pérez', description: 'Full name of the driver.' })
    driverFullName!: string;

    @ApiProperty({ example: 4, description: 'Vehicle of this route batch.' })
    vehicleId!: number;

    @ApiProperty({ example: 'ABC-123', description: 'Plate of the vehicle.' })
    vehiclePlate!: string;

    @ApiProperty({ type: 'integer', nullable: true, example: 2, description: 'Zone of this route batch. null when it has none.' })
    zoneId!: number | null;

    @ApiProperty({ type: String, nullable: true, example: 'Centro', description: 'Name of the zone. null when it has none.' })
    zoneName!: string | null;

    @ApiProperty({ type: 'number', format: 'double', example: 179.5, description: 'Unused vehicle weight capacity, in kilograms.' })
    remainingWeightKg!: number;

    @ApiProperty({ type: 'number', format: 'double', example: 0.4, description: 'Unused vehicle volume capacity, in cubic meters.' })
    remainingVolumeM3!: number;
}
