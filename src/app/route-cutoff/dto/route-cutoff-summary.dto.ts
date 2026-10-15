import { ApiProperty } from '@nestjs/swagger';

export class CutoffBatchFailureDto {
    @ApiProperty({ example: 41, description: 'Batch that stayed `provisional`.' })
    routeBatchId!: number;

    @ApiProperty({
        type: [String],
        example: ['capacity_exceeded', 'driver_conflict'],
        description: 'Reasons the validation failed: `capacity_exceeded`, `package_too_large`, `vehicle_missing`, `vehicle_inactive`, `vehicle_conflict`, `driver_inactive`, `driver_conflict`, `slot_not_met`, `packages_missing`, `destination_incomplete`, `reoptimization_incomplete`. The full detail is in the batch events (`cutoff_failed`).',
    })
    reasons!: string[];
}

export class RouteCutoffSummaryDto {
    @ApiProperty({
        example: 'executed',
        enum: ['executed', 'blocked', 'not_cutoff_day', 'nothing_to_process'],
        description: '`blocked`: a mandatory setting is missing on a scheduled run (a manual run answers 422). `not_cutoff_day`: a scheduled run on a day that is not the previous operating day of the next route day. `nothing_to_process`: no provisional batch for that day.',
    })
    status!: 'executed' | 'blocked' | 'not_cutoff_day' | 'nothing_to_process';

    @ApiProperty({ type: String, format: 'date', nullable: true, example: '2026-10-14', description: 'Route day the cutoff worked on; `null` when it did not run.' })
    shiftDate!: string | null;

    @ApiProperty({ type: [Number], description: 'Batches that passed the validation and now wait for the 2nd approval (`pending_final_review`).' })
    pendingFinalReviewBatchIds!: number[];

    @ApiProperty({ type: [CutoffBatchFailureDto], description: 'Batches that failed the validation and went back to `provisional` with their reasons.' })
    failedBatches!: CutoffBatchFailureDto[];

    @ApiProperty({ type: [Number], description: 'New batches born by dividing another one.' })
    createdBatchIds!: number[];

    @ApiProperty({ type: [Number], description: 'Provisional batches that hold the orders whose response window is still open; they need the coordinator.' })
    remnantBatchIds!: number[];

    @ApiProperty({ type: [Number], description: 'Batches cancelled because they were merged into another or were left empty.' })
    cancelledBatchIds!: number[];

    @ApiProperty({ type: [Number], description: 'Orders without promise that left their batch and went back to `pending`.' })
    releasedDispatchIds!: number[];

    @ApiProperty({ type: [Number], description: 'Batches left out because a stop has no sequence or no point on the map.' })
    skippedBatchIds!: number[];

    @ApiProperty({ type: Number, description: 'Groups (day, zone, warehouse) left as they were because an order or batch changed while the cutoff was computing.' })
    staleGroups!: number;

    @ApiProperty({ type: [String], description: 'Mandatory settings that were empty or invalid when `status` is `blocked`.' })
    missingKeys!: string[];
}
