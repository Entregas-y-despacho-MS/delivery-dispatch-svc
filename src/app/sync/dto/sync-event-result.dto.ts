import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum SyncEventOutcome {
    APPLIED            = 'applied',
    ALREADY_PROCESSED  = 'already_processed',
    FAILED             = 'failed',
}

export class SyncEventResultDto {
    @ApiProperty({ example: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10' })
    clientEventId: string;

    @ApiProperty({ enum: SyncEventOutcome })
    outcome: SyncEventOutcome;

    // Only present when outcome === FAILED — lets the device know this one still needs a retry
    // (with a fix), instead of silently marking it synced: true.
    @ApiPropertyOptional({ example: 'Dispatch not found.' })
    error?: string;
}

export class SyncEventsBatchResultDto {
    @ApiProperty({ type: [SyncEventResultDto] })
    results: SyncEventResultDto[];
}
