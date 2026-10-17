import { ApiExtraModels, ApiProperty } from '@nestjs/swagger';
import { nullableRef } from './nullable-ref.js';
import { RouteCapacityReportDto } from './route-capacity-report.dto.js';
import { RouteBatchSummaryDto } from './route-batch-summary.dto.js';

export class RouteBatchPackageDto {
    @ApiProperty({ type: 'integer', example: 82, description: 'Id of the package' })
    id!: number;

    @ApiProperty({ type: String, example: 'PKG-0001', description: 'Package id in the warehouse system' })
    externalPackageId!: string;

    @ApiProperty({ type: 'number', format: 'double', example: 40, description: 'Length in centimeters' })
    lengthCm!: number;

    @ApiProperty({ type: 'number', format: 'double', example: 30, description: 'Width in centimeters' })
    widthCm!: number;

    @ApiProperty({ type: 'number', format: 'double', example: 20, description: 'Height in centimeters' })
    heightCm!: number;

    @ApiProperty({ type: 'number', format: 'double', example: 12.5, description: 'Gross weight in kilograms' })
    grossWeightKg!: number;
}

export class RouteBatchDispatchDto {
    @ApiProperty({ type: 'integer', example: 31, description: 'Id of the dispatch. Send it in `removeDispatchIds` to take it out of the batch when approving the promises' })
    dispatchId!: number;

    @ApiProperty({ type: 'integer', example: 4, description: 'Planning version of the dispatch. Send it back as the expected version when approving' })
    version!: number;

    @ApiProperty({ type: String, example: 'in_planning', description: 'Status of the dispatch' })
    status!: string;

    @ApiProperty({ type: 'integer', nullable: true, example: 1, description: 'Position of the dispatch in the route; null when it has none yet' })
    sequenceOrder!: number | null;

    @ApiProperty({ type: String, example: 'SO-1042', description: 'Order reference in the origin system' })
    sourceOrderRef!: string;

    @ApiProperty({ type: String, example: 'Av. Costanera 123', description: 'Delivery address' })
    deliveryAddress!: string;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'Start of the proposed time window; null when none' })
    scheduledWindowStart!: Date | null;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'End of the proposed time window; null when none' })
    scheduledWindowEnd!: Date | null;

    @ApiProperty({ type: Boolean, example: false, description: 'true when the dispatch has no registered packages and its weight is an estimate' })
    estimated!: boolean;

    @ApiProperty({ type: () => RouteBatchPackageDto, isArray: true, description: 'Registered packages of the dispatch; empty when none yet' })
    packages!: RouteBatchPackageDto[];
}

export class RouteBatchValidationDto {
    @ApiProperty({ enum: ['validated', 'failed'], example: 'failed', description: '`validated`: the last cutoff passed (the batch waits for the 2nd approval). `failed`: the last cutoff failed and the batch went back to `provisional`' })
    result!: 'validated' | 'failed';

    @ApiProperty({ type: String, format: 'date-time', description: 'When the system validation ran' })
    occurredAt!: Date;

    @ApiProperty({ type: String, nullable: true, example: 'capacity_exceeded,slot_not_met', description: 'Comma-separated failure codes; null when the validation passed' })
    reason!: string | null;

    @ApiProperty({ type: 'object', additionalProperties: true, isArray: true, description: 'Failures as stored by the cutoff: `{ code, dispatchIds, detail }`. Empty when the validation passed' })
    failures!: Array<Record<string, unknown>>;

    @ApiProperty({ type: 'object', additionalProperties: true, isArray: true, description: 'Warnings as stored by the cutoff, e.g. `driver_missing`: `{ code, dispatchIds, detail }`' })
    warnings!: Array<Record<string, unknown>>;
}

@ApiExtraModels(RouteCapacityReportDto, RouteBatchValidationDto)
export class RouteBatchDetailDto extends RouteBatchSummaryDto {
    @ApiProperty({ type: () => RouteBatchDispatchDto, isArray: true, description: 'Dispatches of the batch in route order (`sequenceOrder`, then id)' })
    dispatches!: RouteBatchDispatchDto[];

    @ApiProperty({ ...nullableRef(RouteCapacityReportDto), description: 'Full capacity report of the vehicle (including `assignable`); null when the batch has no vehicle' })
    capacity!: RouteCapacityReportDto | null;

    @ApiProperty({ ...nullableRef(RouteBatchValidationDto), description: 'Result of the last system validation (cutoff) of the batch; null when it has never been validated' })
    validation!: RouteBatchValidationDto | null;
}
