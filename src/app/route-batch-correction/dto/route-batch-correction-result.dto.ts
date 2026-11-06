import { ApiExtraModels, ApiProperty } from '@nestjs/swagger';
import { nullableRef } from '../../../modules/dispatch/route-batches/dto/nullable-ref.js';
import { RouteCapacityReportDto } from '../../../modules/dispatch/route-batches/dto/route-capacity-report.dto.js';

export class RouteBatchCorrectionValidationDto {
    @ApiProperty({ description: 'Whether the corrected batch passes the validation of the D-1 cutoff (capacity, vehicle, driver, promised slots).', example: false })
    passed!: boolean;

    @ApiProperty({
        type: 'object',
        additionalProperties: true,
        isArray: true,
        description: 'Why the batch is not viable, as stored in its event log: `{ code, dispatchIds, detail }`. Empty when the validation passed.',
    })
    failures!: Array<Record<string, unknown>>;

    @ApiProperty({
        type: 'object',
        additionalProperties: true,
        isArray: true,
        description: 'Issues that do not block the review, e.g. `driver_missing` (the coordinator can still assign the driver): `{ code, dispatchIds, detail }`.',
    })
    warnings!: Array<Record<string, unknown>>;
}

@ApiExtraModels(RouteCapacityReportDto, RouteBatchCorrectionValidationDto)
export class RouteBatchCorrectionResultDto {
    @ApiProperty({ description: 'Identifier of the corrected route batch.', type: 'integer', example: 12 })
    routeBatchId!: number;

    @ApiProperty({
        description: 'Planning version of the batch after the correction. Send it as the expected version of the next write. Unchanged when `changed` is false.',
        type: 'integer',
        example: 5,
    })
    version!: number;

    @ApiProperty({
        description: 'Status after the correction. A batch that was pending final review goes back to `provisional` when the new validation fails; a confirmed vehicle replacement keeps the batch confirmed.',
        enum: ['provisional', 'pending_final_review', 'confirmed'],
        example: 'pending_final_review',
    })
    status!: 'provisional' | 'pending_final_review' | 'confirmed';

    @ApiProperty({ description: 'Vehicle of the batch after the correction; null when it has none.', type: 'integer', nullable: true, example: 8 })
    vehicleId!: number | null;

    @ApiProperty({ description: 'Proposed driver of the batch after the correction; null when it has none.', type: 'integer', nullable: true, example: 34 })
    proposedDriverId!: number | null;

    @ApiProperty({ description: 'False when the value sent was already the one in the batch: nothing was written and the version did not change.', example: true })
    changed!: boolean;

    @ApiProperty({
        ...nullableRef(RouteCapacityReportDto),
        description: 'Capacity check of the new vehicle. Only present when a vehicle was assigned (null for a driver change or when nothing changed).',
    })
    capacity!: RouteCapacityReportDto | null;

    @ApiProperty({
        ...nullableRef(RouteBatchCorrectionValidationDto),
        description: 'Result of the validation run after correcting a batch pending final review. Null in a provisional batch (it is validated by the next cutoff) and when nothing changed.',
    })
    validation!: RouteBatchCorrectionValidationDto | null;
}
