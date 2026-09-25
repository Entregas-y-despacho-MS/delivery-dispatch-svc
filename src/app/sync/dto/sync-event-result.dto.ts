import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum SyncEventOutcome {
    APPLIED            = 'applied',
    ALREADY_PROCESSED  = 'already_processed',
    FAILED             = 'failed',
}

export class SyncEventResultDto {
    @ApiProperty({ example: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10', description: 'The `clientEventId` of the event this result is about' })
    clientEventId: string;

    @ApiProperty({ enum: SyncEventOutcome, description: 'applied = saved now · already_processed = it had been saved by an earlier attempt, nothing changed · failed = not saved, see `error`; keep it on the device and retry once fixed' })
    outcome: SyncEventOutcome;

    // Only present when outcome === FAILED — lets the device know this one still needs a retry
    // (with a fix), instead of silently marking it synced: true.
    @ApiPropertyOptional({ description: 'Why it failed (e.g. "Dispatch not found."). Only present when outcome = failed' })
    error?: string;
}

export class SyncEventsBatchResultDto {
    @ApiProperty({ type: [SyncEventResultDto], description: 'One result per event, in the same order as sent' })
    results: SyncEventResultDto[];
}
