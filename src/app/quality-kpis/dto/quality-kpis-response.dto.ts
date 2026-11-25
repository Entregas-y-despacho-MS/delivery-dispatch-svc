import { ApiProperty } from '@nestjs/swagger';
import { KpiUnit } from '../domain/kpi.js';

const COUNT = (description: string) => ({ type: 'integer' as const, minimum: 0, description });

export class QualityKpiDto {
    @ApiProperty({ type: String, example: 'incident_rate', description: 'Stable code of the indicator' })
    code!: string;

    @ApiProperty({ type: String, description: 'The rule in words, as the screen shows it' })
    formula!: string;

    @ApiProperty({ enum: KpiUnit, description: 'Unit of `value`: a percentage, minutes or a rating score' })
    unit!: KpiUnit;

    @ApiProperty({ type: 'number', format: 'double', nullable: true, minimum: 0, description: 'Numerator of the rate; null when the indicator has none (median, N/D)' })
    numerator!: number | null;

    @ApiProperty({ type: 'number', format: 'double', nullable: true, minimum: 0, description: 'Denominator of the rate; null when the indicator has none (median, N/D)' })
    denominator!: number | null;

    @ApiProperty(COUNT('Sample size behind `value`'))
    n!: number;

    @ApiProperty({ type: 'number', format: 'double', nullable: true, minimum: 0, description: 'The figure. null with `available: true` means «Sin datos» (nothing to measure); null with `available: false` is N/D, with its cause in `reason`. Never a made-up 0' })
    value!: number | null;

    @ApiProperty({ type: Boolean, description: 'false when the value cannot be told (N/D); the counts are still shown' })
    available!: boolean;

    @ApiProperty({ type: String, nullable: true, example: 'attempt_coverage_incomplete', description: 'Why the value is N/D: attempt_coverage_incomplete, investigation_timestamp_missing, rating_not_authorized or response_opportunity_not_recorded. null when it is available' })
    reason!: string | null;

    @ApiProperty({ type: String, example: 'promise_window_end', description: 'Date the cohort of this indicator is placed by (`promise_window_end` or `closed_at`)' })
    dateBasis!: string;
}

export class QualityPeriodDto {
    @ApiProperty({ type: String, format: 'date', description: 'First day of the range (Bolivia day)' })
    from!: string;

    @ApiProperty({ type: String, format: 'date', description: 'Last day of the range (Bolivia day)' })
    to!: string;

    @ApiProperty({ type: String, example: 'America/La_Paz', description: 'Time zone the days are presented in; the calculation uses UTC timestamps' })
    timeZone!: string;
}

export class QualityAppliedFiltersDto {
    @ApiProperty({ type: 'integer', nullable: true, description: 'Zone filter applied; null when none' })
    zoneId!: number | null;

    @ApiProperty({ type: String, nullable: true, description: 'Status filter applied; null when none' })
    status!: string | null;

    @ApiProperty({ type: 'integer', nullable: true, description: 'Incident reason filter applied; null when none' })
    incidentReasonId!: number | null;

    @ApiProperty({ type: String, nullable: true, description: 'Complaint reason code filter applied; null when none' })
    reasonCode!: string | null;

    @ApiProperty({ type: Boolean, nullable: true, description: 'Reschedule filter applied; null when none' })
    rescheduled!: boolean | null;
}

export class QualityKpisDto {
    @ApiProperty({ type: QualityKpiDto, description: 'Dispatches with an incident per 100 valid attempts; two incidents of the same attempt count once' })
    incidentRate!: QualityKpiDto;

    @ApiProperty({ type: QualityKpiDto, description: 'Unique eligible dispatches rescheduled over unique eligible dispatches of the cohort; reschedule events are shown apart' })
    rescheduleRate!: QualityKpiDto;

    @ApiProperty({ type: QualityKpiDto, description: 'CRM cases on delivered dispatches over unique delivered dispatches' })
    complaintRate!: QualityKpiDto;

    @ApiProperty({ type: QualityKpiDto, description: 'Median minutes from the start of the investigation to the decision, only for cases with both timestamps; open cases are out of it' })
    investigationTime!: QualityKpiDto;

    @ApiProperty({ type: QualityKpiDto, description: 'Mean rating. N/D with `rating_not_authorized` for a role that may not read the global rating' })
    ratingAverage!: QualityKpiDto;

    @ApiProperty({ type: QualityKpiDto, description: 'Response rate of the rating. N/D with `response_opportunity_not_recorded` until who was invited to rate is recorded' })
    responseRate!: QualityKpiDto;
}

export class QualityAttemptsDetailDto {
    @ApiProperty(COUNT('Valid attempts rebuilt from the status events (the denominator of the incident rate)'))
    attemptCount!: number;

    @ApiProperty(COUNT('Attempts with at least one incident that consumes an attempt (the numerator)'))
    attemptsWithIncidentCount!: number;

    @ApiProperty(COUNT('Dispatches with at least one of those attempts'))
    dispatchesWithIncidentCount!: number;

    @ApiProperty(COUNT('Distinct incident events that consume an attempt, before collapsing them by attempt; never in the rate'))
    incidentEventCount!: number;

    @ApiProperty(COUNT('Distinct incidents whose reason does not consume an attempt: not an attempt, outside the rate'))
    incidentsWithoutAttemptCount!: number;

    @ApiProperty(COUNT('Dispatches whose history cannot be turned into attempts; out of both sides of the rate'))
    notReconstructableCount!: number;
}

export class QualityReschedulesDetailDto {
    @ApiProperty(COUNT('Unique dispatches rescheduled at least once (the numerator)'))
    rescheduledDispatchCount!: number;

    @ApiProperty(COUNT('Reschedule events that changed the window; shown apart, they never raise the denominator'))
    rescheduleEventCount!: number;

    @ApiProperty(COUNT('Rows that only moved the route: not a reschedule'))
    reassignmentOnlyCount!: number;

    @ApiProperty(COUNT('Unique eligible dispatches of the cohort (the denominator; cancelled ones are not eligible)'))
    eligibleDispatchCount!: number;
}

export class QualityOpenCasesDto {
    @ApiProperty(COUNT('Cases not decided yet; shown as a count, outside the median'))
    count!: number;

    @ApiProperty({ type: 'integer', nullable: true, minimum: 0, description: 'Age in minutes of the oldest open case; null with none' })
    oldestAgeMinutes!: number | null;
}

export class QualityComplaintsDetailDto {
    @ApiProperty(COUNT('Valid cases, one per case, on delivered dispatches (the numerator)'))
    caseCount!: number;

    @ApiProperty(COUNT('Delivered dispatches with at least one case'))
    dispatchesWithCaseCount!: number;

    @ApiProperty(COUNT('Unique delivered dispatches of the cohort (the denominator)'))
    deliveredDispatchCount!: number;

    @ApiProperty(COUNT('Decided cases with a missing or inverted timestamp: out of the median'))
    decidedWithoutTimestampsCount!: number;

    @ApiProperty({ type: QualityOpenCasesDto, description: 'Open cases: quantity and age' })
    open!: QualityOpenCasesDto;
}

export class QualityAttemptCoverageDto {
    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'First moment attempts can be rebuilt from; null when nothing is instrumented yet' })
    from!: string | null;

    @ApiProperty({ type: Boolean, description: 'true when the whole range starts on or after `from`; false makes the incident rate N/D' })
    complete!: boolean;
}

export class QualityDetailsDto {
    @ApiProperty({ type: QualityAttemptsDetailDto, description: 'Counts behind the incident rate' })
    attempts!: QualityAttemptsDetailDto;

    @ApiProperty({ type: QualityReschedulesDetailDto, description: 'Counts behind the reschedule rate' })
    reschedules!: QualityReschedulesDetailDto;

    @ApiProperty({ type: QualityComplaintsDetailDto, description: 'Counts behind the claim indicators' })
    complaints!: QualityComplaintsDetailDto;

    @ApiProperty({ type: QualityAttemptCoverageDto, description: 'Whether the range is inside the instrumented period' })
    attemptCoverage!: QualityAttemptCoverageDto;
}

export class QualityPageMetaDto {
    @ApiProperty({ type: 'integer', description: 'Current page number' })
    page!: number;

    @ApiProperty({ type: 'integer', description: 'Items per page' })
    limit!: number;

    @ApiProperty({ type: 'integer', description: 'Total number of pages (0 when there are no results)' })
    pages!: number;

    @ApiProperty({ type: 'integer', description: 'Total number of records matching the filters' })
    total!: number;
}

export class QualityCaseItemDto {
    @ApiProperty({ type: 'integer', description: 'ID of the complaint case' })
    caseId!: number;

    @ApiProperty({ type: 'integer', description: 'ID of the delivered dispatch the case is about' })
    dispatchId!: number;

    @ApiProperty({ type: String, description: 'Reason code of the complaint, as CRM sent it' })
    reasonCode!: string;

    @ApiProperty({ type: String, description: 'Investigation status: received, assigned, in_investigation or decided' })
    investigationStatus!: string;

    @ApiProperty({ type: String, format: 'date-time', description: 'When the case was opened in CRM (UTC)' })
    openedAt!: string;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'When the investigation started; null if not yet' })
    investigationStartedAt!: string | null;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'When the verdict was issued; null while open' })
    decidedAt!: string | null;

    @ApiProperty({ type: Boolean, description: 'true while the case has no verdict' })
    open!: boolean;

    @ApiProperty({ type: 'integer', nullable: true, minimum: 0, description: 'Minutes since it was opened, only for an open case; null once decided' })
    ageMinutes!: number | null;
}

export class QualityDispatchItemDto {
    @ApiProperty({ type: 'integer', description: 'ID of the delivery dispatch' })
    dispatchId!: number;

    @ApiProperty({ type: String, description: 'Current status of the dispatch' })
    status!: string;

    @ApiProperty(COUNT('Valid attempts rebuilt for this dispatch; 0 with `reconstructable: false` means «cannot be told», not «no attempt»'))
    attemptCount!: number;

    @ApiProperty(COUNT('Attempts with at least one incident'))
    attemptsWithIncidentCount!: number;

    @ApiProperty(COUNT('Distinct incident events that consume an attempt'))
    incidentEventCount!: number;

    @ApiProperty({ type: Boolean, description: 'Its delivery window was changed at least once' })
    rescheduled!: boolean;

    @ApiProperty({ type: Boolean, description: 'false when its history cannot be turned into attempts' })
    reconstructable!: boolean;
}

export class QualityCasesPageDto {
    @ApiProperty({ type: QualityCaseItemDto, isArray: true, description: 'Cases of this page, with the filters applied' })
    data!: QualityCaseItemDto[];

    @ApiProperty({ type: QualityPageMetaDto, description: 'Pagination metadata' })
    meta!: QualityPageMetaDto;
}

export class QualityDispatchesPageDto {
    @ApiProperty({ type: QualityDispatchItemDto, isArray: true, description: 'Dispatches of this page, with the filters applied' })
    data!: QualityDispatchItemDto[];

    @ApiProperty({ type: QualityPageMetaDto, description: 'Pagination metadata' })
    meta!: QualityPageMetaDto;
}

export class QualityTablesDto {
    @ApiProperty({ type: QualityCasesPageDto, description: 'The complaint cases, apart from the dispatches' })
    cases!: QualityCasesPageDto;

    @ApiProperty({ type: QualityDispatchesPageDto, description: 'The dispatches of the cohort, apart from the cases' })
    dispatches!: QualityDispatchesPageDto;
}

export class QualityKpisReportDto {
    @ApiProperty({ type: QualityPeriodDto, description: 'Period and time zone of the answer' })
    period!: QualityPeriodDto;

    @ApiProperty({ type: QualityAppliedFiltersDto, description: 'Filters that were applied (null = not applied)' })
    filters!: QualityAppliedFiltersDto;

    @ApiProperty({ type: QualityKpisDto, description: 'The indicators, each with its formula, numerator, denominator, `n` and date basis' })
    kpis!: QualityKpisDto;

    @ApiProperty({ type: QualityDetailsDto, description: 'Counts shown apart that never enter a numerator or denominator' })
    details!: QualityDetailsDto;

    @ApiProperty({ type: QualityTablesDto, description: 'Cases and dispatches, paginated. No personal data and no evidence URL' })
    tables!: QualityTablesDto;

    @ApiProperty({ type: String, isArray: true, description: 'Tables the figures were read from; `dispatch_ratings` only when the caller may read the rating' })
    sources!: string[];
}
