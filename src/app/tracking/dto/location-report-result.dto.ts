import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum LocationReportOutcome {
    APPLIED = 'applied',
    STALE   = 'stale',
    FAILED  = 'failed',
}

export class LocationReportResultDto {
    @ApiProperty({ type: 'integer', example: 42, description: 'The `dispatchId` of the point this result is about' })
    dispatchId: number;

    @ApiProperty({ enum: LocationReportOutcome, description: 'applied = it was the newest point for this dispatch, saved and broadcast · stale = an equal-or-newer point was already stored (from an earlier report or another point in this same batch) — not an error, safe to ignore · failed = not saved, see `error`' })
    outcome: LocationReportOutcome;

    @ApiPropertyOptional({ description: 'Why it failed (e.g. "Dispatch not found."). Only present when outcome = failed' })
    error?: string;
}

export class LocationsReportResultDto {
    // Same order as sent (not the chronological order they were applied in) — the device matches
    // each result back to the point it sent by position, same convention as /sync/events.
    @ApiProperty({ type: [LocationReportResultDto], description: 'One result per point sent, in the same order as the request' })
    results: LocationReportResultDto[];
}
