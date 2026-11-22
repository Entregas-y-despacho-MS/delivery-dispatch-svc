import { ApiProperty } from '@nestjs/swagger';
import { OtdBasis } from '../domain/otd-basis.js';

export class AppliedFiltersDto {
    @ApiProperty({ type: 'integer', nullable: true, description: 'Zone filter that was applied; null when none' })
    zoneId!: number | null;

    @ApiProperty({ type: 'integer', nullable: true, description: 'Service-level filter that was applied; null when none' })
    serviceLevelId!: number | null;

    @ApiProperty({ type: String, nullable: true, description: 'Status filter that was applied; null when none' })
    status!: string | null;
}

export class ExcludedCancellationsDto {
    @ApiProperty({ type: 'integer', minimum: 0, example: 3, description: 'Cancelled dispatches left out of the rate because they were cancelled on or before the end of the promise in force when they were cancelled' })
    count!: number;

    @ApiProperty({ type: String, example: 'cancelled_before_promise_expired', description: 'The rule that excluded them. A cancellation after the promise expired stays in the denominator as not on time' })
    reason!: string;
}

export class OtdMetricsDto {
    @ApiProperty({ type: 'integer', minimum: 0, example: 35, description: 'Numerator: eligible dispatches delivered inside their committed window (both ends included)' })
    numerator!: number;

    @ApiProperty({ type: 'integer', minimum: 0, example: 42, description: 'Denominator: the eligible universe. For `basis=promise`, delivery dispatches with a valid window whose promise expired inside the range, open and not delivered ones included. For `basis=deliveredAt`, the delivered ones closed inside the range' })
    denominator!: number;

    @ApiProperty({ type: 'integer', minimum: 0, example: 42, description: 'Sample size of the rate; the same figure as `denominator`, shown with the rate' })
    n!: number;

    @ApiProperty({ type: 'number', format: 'double', nullable: true, minimum: 0, maximum: 100, example: 83.3, description: 'numerator / denominator as a percentage with one decimal; 100 only when none is out of the window. null (shown as "Sin datos") when the denominator is 0, never 0' })
    percentage!: number | null;

    @ApiProperty({ type: 'integer', minimum: 0, example: 7, description: 'Eligible dispatches that were not delivered inside the window (delivered late, still open, not delivered, returned or cancelled after the promise expired)' })
    notOnTimeCount!: number;

    @ApiProperty({ type: 'integer', minimum: 0, example: 1, description: 'Dispatches without a valid window (missing, or ending before it starts). Shown apart: they are neither in the denominator nor counted as 0' })
    invalidWindowCount!: number;

    @ApiProperty({ type: ExcludedCancellationsDto, description: 'Cancellations excluded from the denominator, with the reason' })
    excludedCancellations!: ExcludedCancellationsDto;

    @ApiProperty({ type: 'integer', minimum: 0, example: 0, description: 'Cancelled dispatches with no window, so it cannot be told whether the promise had expired when they were cancelled. They are out of the rate; above 0 the rate is not reliable (N/D for the affected history)' })
    unreconstructableCancellationCount!: number;

    @ApiProperty({ type: 'integer', minimum: 0, example: 4, description: 'Eligible dispatches whose window was changed after it was first promised. They are measured against the window in force (the last one accepted); the original promise is kept in the reschedule history for comparison' })
    rescheduledPromiseCount!: number;
}

export class AttemptCoverageDto {
    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'First moment the attempts can be rebuilt from (the first status event the backend wrote with the previous status). null when there is none yet' })
    from!: string | null;

    @ApiProperty({ type: Boolean, description: 'true when the whole range starts on or after `from`. false: the rate is N/D because part of the range is not instrumented' })
    complete!: boolean;
}

export class FirstAttemptDto {
    @ApiProperty({ type: Boolean, example: true, description: 'false when the first-attempt rate is N/D: the range starts before the instrumented period (`coverage.complete` false) or it was not computed. true with a null `percentage` means "Sin datos" (nothing to measure)' })
    available!: boolean;

    @ApiProperty({ type: String, nullable: true, example: 'attempt_coverage_incomplete', description: 'Why the rate is N/D (`attempt_coverage_incomplete`, `attempt_not_normalized`); null when it is available' })
    reason!: string | null;

    @ApiProperty({ type: 'integer', minimum: 0, example: 30, description: 'Numerator: dispatches whose first attempt ended delivered (on time, late, or with no valid window to tell)' })
    numerator!: number;

    @ApiProperty({ type: 'integer', minimum: 0, example: 40, description: 'Denominator: dispatches whose first attempt already happened and could be rebuilt. Those still waiting for their first chance are not in it' })
    denominator!: number;

    @ApiProperty({ type: 'integer', minimum: 0, example: 40, description: 'Sample size of the rate; the same figure as `denominator`' })
    n!: number;

    @ApiProperty({ type: 'number', format: 'double', nullable: true, minimum: 0, maximum: 100, example: 75, description: 'numerator / denominator as a percentage with one decimal; null (N/D or "Sin datos") when the coverage is incomplete or the denominator is 0, never 0' })
    percentage!: number | null;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'First attempt delivered inside the committed window' })
    onTimeCount!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'First attempt delivered outside the committed window. It counts in the numerator and is shown apart so it is not mistaken for OTD' })
    lateCount!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'First attempt delivered but the dispatch has no valid window, so on time or late cannot be told' })
    deliveredWithoutWindowCount!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'First attempt failed (`not_delivered` or an incident whose reason consumes an attempt)' })
    failedCount!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Dispatches whose first chance has not happened yet: out of the denominator' })
    noAttemptYetCount!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Dispatches whose event history does not allow rebuilding their attempts: out of the denominator' })
    notReconstructableCount!: number;

    @ApiProperty({ type: AttemptCoverageDto, description: 'The period the attempts can be rebuilt for' })
    coverage!: AttemptCoverageDto;
}

export class OtdReportDto {
    @ApiProperty({ type: String, format: 'date', example: '2026-11-01', description: 'First Bolivia day of the range, inclusive (YYYY-MM-DD)' })
    from!: string;

    @ApiProperty({ type: String, format: 'date', example: '2026-11-30', description: 'Last Bolivia day of the range, inclusive (YYYY-MM-DD)' })
    to!: string;

    @ApiProperty({ enum: OtdBasis, description: 'Which rate this is: `promise` is the OTD by cohort of expired promise, `deliveredAt` the historic punctuality of completed deliveries (ES-54 semantics)' })
    basis!: OtdBasis;

    @ApiProperty({ type: String, example: 'promise_window_end', description: 'The date the rate was measured on: `promise_window_end` or `closed_at`' })
    dateBasis!: string;

    @ApiProperty({ type: String, example: 'America/La_Paz', description: 'Time zone of the days of the range' })
    timeZone!: string;

    @ApiProperty({ type: String, format: 'date-time', description: 'The moment the query ran: a promise counts as expired when it ended before it' })
    asOf!: string;

    @ApiProperty({ type: AppliedFiltersDto, description: 'The filters this answer was computed with' })
    filters!: AppliedFiltersDto;

    @ApiProperty({ type: OtdMetricsDto, description: 'The rate with its numerator, denominator, sample size, invalid windows and excluded cancellations' })
    metrics!: OtdMetricsDto;

    @ApiProperty({ type: FirstAttemptDto, description: 'First-attempt delivery: N/D with its reason until the attempt is normalized' })
    firstAttempt!: FirstAttemptDto;

    @ApiProperty({ type: Boolean, description: 'true when the filters leave nothing to measure (denominator 0 and nothing excluded): the screen shows "Sin datos"' })
    empty!: boolean;
}
