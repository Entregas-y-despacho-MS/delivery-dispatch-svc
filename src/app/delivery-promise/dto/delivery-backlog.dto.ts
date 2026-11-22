import { ApiProperty } from '@nestjs/swagger';
import { AgeRange, NextAction } from '../domain/backlog-buckets.js';
import { FirstAttemptResult } from '../domain/first-attempt.js';
import { AppliedFiltersDto } from './otd-report.dto.js';

export class AgeBreakdownDto {
    @ApiProperty({ type: 'integer', minimum: 0, description: 'In the stage for less than 1 day' })
    [AgeRange.UNDER_1_DAY]!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'In the stage for 1 day or more, and less than 3' })
    [AgeRange.ONE_TO_3_DAYS]!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'In the stage for 3 days or more' })
    [AgeRange.OVER_3_DAYS]!: number;
}

export class PendingStageDto {
    @ApiProperty({ type: String, example: 'scheduled', description: 'The stage: the current status of the dispatches (one stage per status, so a dispatch is in exactly one)' })
    stage!: string;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Active dispatches in this stage whose promise has not expired' })
    total!: number;

    @ApiProperty({ type: AgeBreakdownDto, description: 'The same dispatches by how long they have been in the stage' })
    byAge!: AgeBreakdownDto;
}

export class BacklogCountsDto {
    @ApiProperty({ type: 'integer', minimum: 0, description: 'Delivered, counted by their own dispatch: one delivered inside a batch still in execution counts already' })
    delivered!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Active dispatches (not finished) whose promise already expired. They are not in `pending`' })
    openOverdue!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Active dispatches whose promise has not expired, or that have no valid window: the sum of `pendingByStage`' })
    pending!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Closed as `not_delivered` (failed)' })
    notDelivered!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Waiting for a new window (`rescheduled`)' })
    rescheduled!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Cancelled' })
    cancelled!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Returned (`returned` and `returned_to_warehouse`)' })
    returned!: number;
}

export class OpenOverdueDispatchDto {
    @ApiProperty({ type: 'integer', minimum: 1, description: 'ID of the dispatch' })
    dispatchId!: number;

    @ApiProperty({ type: String, nullable: true, description: 'Tracking code (código de guía); null if it has none yet' })
    trackingCode!: string | null;

    @ApiProperty({ type: String, example: 'assigned', description: 'Current status of the dispatch' })
    status!: string;

    @ApiProperty({ type: 'integer', nullable: true, description: 'Delivery zone ID; null when the dispatch has none' })
    zoneId!: number | null;

    @ApiProperty({ type: 'integer', nullable: true, description: 'Service-level ID; null when the dispatch has none' })
    serviceLevelId!: number | null;

    @ApiProperty({ type: String, format: 'date-time', description: 'End of the committed window that expired' })
    promiseEnd!: string;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Minutes since the promise expired' })
    overdueMinutes!: number;

    @ApiProperty({ enum: NextAction, description: 'What the coordinator has to do next, derived from the stage the dispatch is stuck in' })
    nextAction!: NextAction;

    @ApiProperty({ type: 'integer', nullable: true, minimum: 0, example: 1, description: 'Valid delivery attempts the dispatch has used (a trip that ended in a result; a `not_delivered` and the incident that caused it count once); 0 when its first chance has not happened. null when its history does not allow rebuilding them' })
    attemptsUsed!: number | null;

    @ApiProperty({ enum: FirstAttemptResult, enumName: 'FirstAttemptResult', example: 'no_attempt_yet', description: 'How the first attempt went: `on_time`, `late`, `delivered_no_window`, `failed`, `no_attempt_yet` (its first chance has not happened) or `not_reconstructable`' })
    firstAttemptResult!: FirstAttemptResult;
}

export class DeliveryBacklogDto {
    @ApiProperty({ type: String, format: 'date', example: '2026-11-01', description: 'First Bolivia day of the range, inclusive (YYYY-MM-DD)' })
    from!: string;

    @ApiProperty({ type: String, format: 'date', example: '2026-11-30', description: 'Last Bolivia day of the range, inclusive (YYYY-MM-DD)' })
    to!: string;

    @ApiProperty({ type: String, example: 'promise_window_end', description: 'The date the range is matched against: the end of the committed window' })
    dateBasis!: string;

    @ApiProperty({ type: String, example: 'America/La_Paz', description: 'Time zone of the days of the range' })
    timeZone!: string;

    @ApiProperty({ type: String, format: 'date-time', description: 'The cut: a promise counts as expired when it ended before it' })
    asOf!: string;

    @ApiProperty({ type: AppliedFiltersDto, description: 'The filters this answer was computed with' })
    filters!: AppliedFiltersDto;

    @ApiProperty({ type: BacklogCountsDto, description: 'Mutually exclusive counts by dispatch: every dispatch is in exactly one of them' })
    counts!: BacklogCountsDto;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'The backlog: `openOverdue` + `pending`. Terminal buckets (delivered, not delivered, cancelled, returned) and rescheduled are never added to it' })
    backlogTotal!: number;

    @ApiProperty({ type: [PendingStageDto], description: 'Pending dispatches by exclusive stage and age. Only the stages that have dispatches' })
    pendingByStage!: PendingStageDto[];

    @ApiProperty({ type: AgeBreakdownDto, description: 'Open overdue dispatches by how long they have been in their current stage' })
    openOverdueByAge!: AgeBreakdownDto;

    @ApiProperty({ type: [OpenOverdueDispatchDto], description: 'The open overdue dispatches, the most overdue first, up to `overdueLimit`' })
    openOverdue!: OpenOverdueDispatchDto[];

    @ApiProperty({ type: Boolean, description: 'true when the filters leave no dispatch at all: the screen shows "Sin datos"' })
    empty!: boolean;
}
