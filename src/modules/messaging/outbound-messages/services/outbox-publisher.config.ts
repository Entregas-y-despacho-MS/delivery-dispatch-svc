import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Fast phase: waits after the 1st, 2nd and 3rd failure (1 s, 2 s, 4 s). After the 3rd failure the
 * broker is considered down and the message enters the slow phase (`slowRetrySeconds` between
 * attempts, until `giveUpAfterMinutes` since the message was queued).
 */
export const OUTBOX_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];

/** Written once, when the fast phase ends: the broker looks down, the message keeps being retried. */
export const OUTBOUND_MESSAGE_DELAYED_ACTION = 'outbound_message_delayed';

/** Written when the message is given up on and left in `failed` (terminal). */
export const OUTBOUND_MESSAGE_FAILED_ACTION = 'outbound_message_failed';

@Injectable()
export class OutboxPublisherConfig {
    /** How often the outbox is polled. 0 disables the timer (messages are then published only by `publishPending`). */
    readonly pollIntervalMs: number;
    /** Wait between attempts once the fast phase (1 s, 2 s, 4 s) is over. */
    readonly slowRetrySeconds: number;
    /** A message that still cannot be published this long after it was queued is left in `failed`. */
    readonly giveUpAfterMinutes: number;
    /** Messages claimed per poll. */
    readonly batchSize: number;
    /** A claimed message that is not resolved within this time becomes available again (crashed instance). */
    readonly leaseSeconds: number;
    /** A publish that takes longer counts as a failed attempt. */
    readonly publishTimeoutMs: number;

    constructor(config: ConfigService) {
        this.pollIntervalMs = config.get<number>('OUTBOX_POLL_INTERVAL_MS')!;
        this.slowRetrySeconds = config.get<number>('OUTBOX_SLOW_RETRY_SECONDS')!;
        this.giveUpAfterMinutes = config.get<number>('OUTBOX_GIVE_UP_AFTER_MINUTES')!;
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
