import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Waits between attempts: after the 1st failure 1 s, after the 2nd 2 s, after the 3rd 4 s. */
export const OUTBOX_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];

/** Action stored in `audit_logs` when a message exhausts its attempts. */
export const OUTBOUND_MESSAGE_FAILED_ACTION = 'outbound_message_failed';

@Injectable()
export class OutboxPublisherConfig {
    /** How often the outbox is polled. 0 disables the timer (messages are then published only by `publishPending`). */
    readonly pollIntervalMs: number;
    /** Attempts before the message is left in `failed` and an alert is written. */
    readonly maxAttempts: number;
    /** Messages claimed per poll. */
    readonly batchSize: number;
    /** A claimed message that is not resolved within this time becomes available again (crashed instance). */
    readonly leaseSeconds: number;
    /** A publish that takes longer counts as a failed attempt. */
    readonly publishTimeoutMs: number;

    constructor(config: ConfigService) {
        this.pollIntervalMs = config.get<number>('OUTBOX_POLL_INTERVAL_MS')!;
        this.maxAttempts = config.get<number>('OUTBOX_MAX_ATTEMPTS')!;
        this.batchSize = config.get<number>('OUTBOX_BATCH_SIZE')!;
        this.leaseSeconds = config.get<number>('OUTBOX_LEASE_SECONDS')!;
        this.publishTimeoutMs = config.get<number>('OUTBOX_PUBLISH_TIMEOUT_MS')!;
    }

    /**
     * The messages of a batch are published one after another, so the lease must outlast the worst
     * case (every publish timing out); otherwise another instance would claim a message that is
     * still waiting its turn and publish it twice.
     */
    get effectiveLeaseSeconds(): number {
        const worstCaseSeconds = Math.ceil((this.batchSize * this.publishTimeoutMs) / 1000) + 5;
        return Math.max(this.leaseSeconds, worstCaseSeconds);
    }
}
