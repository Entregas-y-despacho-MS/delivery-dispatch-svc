import { ApiExtraModels, ApiProperty } from '@nestjs/swagger';
import { nullableRef } from '../../../modules/dispatch/route-batches/dto/nullable-ref.js';
import { NamedRefDto } from '../../planning-pipeline/dto/planning-pipeline.dto.js';

export const SNAPSHOT_UNAVAILABLE_REASONS = ['NO_SNAPSHOT', 'NO_OFFICIAL_SNAPSHOT'] as const;
export type SnapshotUnavailableReason = (typeof SNAPSHOT_UNAVAILABLE_REASONS)[number];

export class CutoffSummaryDto {
    @ApiProperty({ type: 'integer', description: 'Cutoff ID' })
    id!: number;

    @ApiProperty({ type: String, format: 'date', description: 'Operating day of the routes the cutoff planned (YYYY-MM-DD)' })
    shiftDate!: string;

    @ApiProperty({ type: String, format: 'date-time', description: 'UTC instant of the cutoff: when the run started' })
    cutoffAt!: string;

    @ApiProperty({ type: String, example: 'America/La_Paz', description: 'Operating timezone in which `shiftDate` is read' })
    operatingTimezone!: string;

    @ApiProperty({ type: String, enum: ['scheduled', 'manual'], description: '`scheduled` when the task ran at its hour, `manual` when a coordinator ran it by hand' })
    triggerType!: 'scheduled' | 'manual';

    @ApiProperty({ type: String, nullable: true, description: 'Scheduled occurrence (`route-cutoff@YYYY-MM-DDTHH:mm`); `null` for a manual run' })
    occurrence!: string | null;

    @ApiProperty({ type: Boolean, description: 'This is the official cutoff of the day: the first scheduled one. Manual runs and later scheduled ones are listed but never replace it' })
    official!: boolean;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Dispatches eligible in the whole cutoff, with no filter applied. The denominator that respects the filters is `coverage.eligible`' })
    eligible!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Dispatches excluded from the whole cutoff, with no filter applied, each with a code and an explanation' })
    excluded!: number;
}

export class CutoffListResponseDto {
    @ApiProperty({ type: String, format: 'date', description: 'Operating day listed (YYYY-MM-DD)' })
    date!: string;

    @ApiProperty({ type: [CutoffSummaryDto], description: 'Cutoffs of the day, oldest first. Empty when the day has no snapshot (history before ST-302.2 is unknown, it is not rebuilt)' })
    data!: CutoffSummaryDto[];
}

export class CoverageDto {
    @ApiProperty({ type: 'integer', minimum: 0, description: 'Dispatches eligible in the cutoff: the denominator. It never changes after the cutoff, whatever the routes do' })
    eligible!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Eligible dispatches that were confirmed at the second approval after the cutoff' })
    confirmed!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Eligible dispatches not confirmed (yet)' })
    pending!: number;

    @ApiProperty({ type: 'number', format: 'double', minimum: 0, maximum: 100, nullable: true, description: '`confirmed` over `eligible` in percent. `null` when no dispatch was eligible: there is nothing to cover' })
    coveragePct!: number | null;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Dispatches of that day confirmed after the cutoff that were not in its universe. Informational: they never enter `confirmed`, and this count is not filtered by zone, warehouse or shift' })
    confirmedOutsideUniverse!: number;
}

export class ExclusionCountDto {
    @ApiProperty({ type: String, example: 'cutoff_window_open', description: 'Exclusion code' })
    code!: string;

    @ApiProperty({ type: String, description: 'What the code means, as it was explained at the cutoff' })
    explanation!: string;

    @ApiProperty({ type: 'integer', minimum: 1, description: 'Dispatches excluded with this code' })
    count!: number;
}

export class ExcludedDispatchDto {
    @ApiProperty({ type: 'integer', description: 'Dispatch ID' })
    dispatchId!: number;

    @ApiProperty({ type: String, example: 'cutoff_no_promise', description: 'Exclusion code' })
    code!: string;

    @ApiProperty({ type: String, description: 'Readable explanation of the exclusion, as it was given at the cutoff' })
    detail!: string;

    @ApiProperty({ type: 'integer', description: 'Batch the dispatch was in when the cutoff read it (detail, never a unit of count)' })
    routeBatchId!: number;

    @ApiProperty({ type: String, example: '/dispatches/42/detail', description: 'Path of the dispatch detail, to resolve it' })
    detailPath!: string;
}

@ApiExtraModels(ExclusionCountDto, ExcludedDispatchDto)
export class ExcludedDto {
    @ApiProperty({ type: 'integer', minimum: 0, description: 'Dispatches excluded from the cutoff (after the filters)' })
    total!: number;

    @ApiProperty({ type: [ExclusionCountDto], description: 'Exclusions grouped by code, the most frequent first' })
    byCode!: ExclusionCountDto[];

    @ApiProperty({ type: [ExcludedDispatchDto], description: 'Every excluded dispatch with its code and explanation. Not paginated: one operating day' })
    data!: ExcludedDispatchDto[];
}

@ApiExtraModels(CutoffSummaryDto, CoverageDto, ExcludedDto)
export class CutoffCoverageResponseDto {
    @ApiProperty({ type: String, format: 'date', description: 'Operating day of the cutoff (YYYY-MM-DD)' })
    date!: string;

    @ApiProperty({ type: Boolean, description: '`false` when there is no snapshot to read: the coverage is not available (N/A) and is never rebuilt from today\'s statuses' })
    available!: boolean;

    @ApiProperty({ type: String, enum: SNAPSHOT_UNAVAILABLE_REASONS, nullable: true, description: 'Why it is not available: `NO_SNAPSHOT` (no cutoff of that day was saved, or the `cutoffId` asked for does not exist) or `NO_OFFICIAL_SNAPSHOT` (only manual runs exist and no `cutoffId` was given). `null` when available' })
    reason!: SnapshotUnavailableReason | null;

    @ApiProperty({ ...nullableRef(CutoffSummaryDto), description: 'The cutoff the numbers come from; `null` when not available' })
    cutoff!: CutoffSummaryDto | null;

    @ApiProperty({ ...nullableRef(CoverageDto), description: 'Confirmed over eligible of that same cutoff; `null` when not available' })
    coverage!: CoverageDto | null;

    @ApiProperty({ ...nullableRef(ExcludedDto), description: 'The exclusions with code and explanation; `null` when not available' })
    excluded!: ExcludedDto | null;
}

export class OutcomeCountsDto {
    @ApiProperty({ type: 'integer', minimum: 0, description: 'Deliveries that reached `delivered`' })
    delivered!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Pickups that were collected' })
    pickupCompleted!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Stops that left and ended without the expected result (not delivered, incident, returned, rescheduled or cancelled on the way)' })
    unsuccessful!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Stops that left and are still open' })
    pending!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Stops held back when the route left (for example a failed package check)' })
    excludedAtStart!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Confirmed stops that never left because the order was cancelled' })
    cancelledBeforeStart!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Confirmed stops that never left for another reason (rescheduled or moved out of the batch)' })
    removedBeforeStart!: number;
}

export class RouteStopDto {
    @ApiProperty({ type: 'integer', description: 'Dispatch ID' })
    dispatchId!: number;

    @ApiProperty({ type: 'integer', nullable: true, description: 'Visiting order in the baseline; `null` when it had none' })
    sequenceOrder!: number | null;

    @ApiProperty({ type: String, enum: ['delivery', 'supplier_pickup', 'warehouse_return_pickup'], description: 'Dispatch type: a `delivery`, a pickup at a supplier (`supplier_pickup`) or a customer return pickup (`warehouse_return_pickup`)' })
    dispatchType!: string;

    @ApiProperty({ type: String, enum: ['delivered', 'pickup_completed', 'unsuccessful', 'pending', 'excluded_at_start', 'cancelled_before_start', 'removed_before_start'], description: 'Result of this stop, one category only. It does not wait for the batch to close' })
    outcome!: string;

    @ApiProperty({ type: String, example: 'delivered', description: 'Current status of the dispatch' })
    currentStatus!: string;

    @ApiProperty({ type: String, example: '/dispatches/42/detail', description: 'Path of the dispatch detail' })
    detailPath!: string;
}

@ApiExtraModels(NamedRefDto, OutcomeCountsDto, RouteStopDto)
export class RouteCompletionDto {
    @ApiProperty({ type: 'integer', description: 'Route batch ID (detail of the route, never the unit of the KPI)' })
    routeBatchId!: number;

    @ApiProperty({ type: 'integer', description: 'Version of the `started` manifest used as baseline' })
    manifestVersion!: number;

    @ApiProperty({ type: 'integer', description: 'Route version when the route started' })
    routeVersion!: number;

    @ApiProperty({ type: String, format: 'date-time', description: 'When the manifest was frozen, which is when the route started' })
    startedAt!: string;

    @ApiProperty({ ...nullableRef(NamedRefDto), description: 'Vehicle at the start (`name` is the plate)' })
    vehicle!: NamedRefDto | null;

    @ApiProperty({ ...nullableRef(NamedRefDto), description: 'Driver at the start' })
    driver!: NamedRefDto | null;

    @ApiProperty({ ...nullableRef(NamedRefDto), description: 'Delivery zone of the batch' })
    zone!: NamedRefDto | null;

    @ApiProperty({ ...nullableRef(NamedRefDto), description: 'Origin warehouse of the batch' })
    warehouse!: NamedRefDto | null;

    @ApiProperty({ type: OutcomeCountsDto, description: 'Stops of the baseline by result; each stop is in exactly one category' })
    counts!: OutcomeCountsDto;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Stops that left with the route' })
    departed!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Departed stops that already have a result' })
    finalized!: number;

    @ApiProperty({ type: 'number', format: 'double', minimum: 0, maximum: 100, nullable: true, description: '`finalized` over `departed` in percent; `null` when nothing departed' })
    finalizedPct!: number | null;

    @ApiProperty({ type: [RouteStopDto], description: 'Result per stop, in visiting order' })
    stops!: RouteStopDto[];
}

@ApiExtraModels(OutcomeCountsDto)
export class RouteCompletionSummaryDto {
    @ApiProperty({ type: 'integer', minimum: 0, description: 'Routes of the day that have a frozen `started` manifest' })
    routesWithBaseline!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Routes of the day that are running or closed but have no `started` manifest (history before ST-302.2): their completion is unknown (N/A), not rebuilt' })
    routesUnknown!: number;

    @ApiProperty({ type: OutcomeCountsDto, description: 'Stops of every baseline by result, apart: they are never added into one number' })
    counts!: OutcomeCountsDto;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Stops that left with their route' })
    departed!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Departed stops that already have a result' })
    finalized!: number;

    @ApiProperty({ type: 'number', format: 'double', minimum: 0, maximum: 100, nullable: true, description: '`finalized` over `departed` of every baseline, weighted by stops (not an average of route percentages); `null` when nothing departed' })
    finalizedPct!: number | null;
}

@ApiExtraModels(RouteCompletionSummaryDto, RouteCompletionDto)
export class RouteCompletionResponseDto {
    @ApiProperty({ type: String, format: 'date', description: 'Operating day (YYYY-MM-DD)' })
    date!: string;

    @ApiProperty({ type: RouteCompletionSummaryDto, description: 'Totals of the day over the frozen baselines' })
    summary!: RouteCompletionSummaryDto;

    @ApiProperty({ type: [RouteCompletionDto], description: 'Routes with a frozen baseline, by route ID. Not paginated: one operating day' })
    data!: RouteCompletionDto[];

    @ApiProperty({ type: 'integer', isArray: true, description: 'IDs of the routes of the day with no `started` manifest (completion unknown, N/A)' })
    unknownRouteBatchIds!: number[];
}
