import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import { MessageBus } from '../../../../plugins/messaging/message-bus.port.js';
import {
    OUTBOUND_MESSAGE_DELAYED_ACTION,
    OUTBOUND_MESSAGE_FAILED_ACTION,
    OUTBOX_RETRY_DELAYS_MS,
    OutboxPublisherConfig,
} from './outbox-publisher.config.js';

interface ClaimedMessage {
    message_id: string;
    type: string;
    payload: MessageEnvelope;
    attempts: number;
    created_at: Date | string;
    /** Seconds since the message was queued (computed by the database, which owns the clock). */
    age_seconds: string | number;
}

export interface OutboxRunResult {
    sent: number;
    retried: number;
    failed: number;
}

/**
 * Publishes the messages of the outbox (`outbound_messages`) through the `MessageBus`.
 *
 * Each poll claims a batch with one `UPDATE ... FOR UPDATE SKIP LOCKED` that pushes `next_attempt_at`
 * forward (a lease), so several instances never take the same message and no transaction stays
 * open while the broker is called. A message is then:
 *   - published → `sent`;
 *   - not published → retried after 1 s, 2 s and 4 s (fast phase; `next_attempt_at`, survives a
 *     restart). The third failure writes one `outbound_message_delayed` alert in `audit_logs`: the
 *     broker looks down, but the operation in the street is never blocked;
 *   - still not published → one attempt every `slowRetrySeconds`, until the message is older than
 *     `giveUpAfterMinutes`; then `failed` plus an `outbound_message_failed` alert.
 * Delivery is at-least-once: consumers deduplicate by `messageId`.
 */
@Injectable()
export class OutboxPublisherService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(OutboxPublisherService.name);
    private timer: NodeJS.Timeout | null = null;
    private running: Promise<OutboxRunResult> | null = null;

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly bus: MessageBus,
        private readonly config: OutboxPublisherConfig,
    ) {}

    onApplicationBootstrap(): void {
        if (this.config.pollIntervalMs <= 0) return;
        this.timer = setInterval(() => {
            void this.publishPending().catch((error: unknown) => {
                this.logger.error(`Outbox poll failed: ${error instanceof Error ? error.message : String(error)}`);
            });
        }, this.config.pollIntervalMs);
        this.timer.unref();
    }

    async onModuleDestroy(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        await this.running?.catch(() => undefined);
    }

    /** Publishes every message that is due. Overlapping calls share the run in progress. */
    async publishPending(): Promise<OutboxRunResult> {
        if (this.running) return await this.running;
        this.running = this.run();
        try {
            return await this.running;
        } finally {
            this.running = null;
        }
    }

    private async run(): Promise<OutboxRunResult> {
        const result: OutboxRunResult = { sent: 0, retried: 0, failed: 0 };
        for (const message of await this.claim()) {
            try {
                await this.publishWithTimeout(message);
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                try {
                    const outcome = await this.registerFailure(message, detail);
                    if (outcome === 'failed') result.failed++;
                    else if (outcome === 'retried') result.retried++;
                } catch (dbError) {
                    // The database failed too: the lease expires and the message is picked up again.
                    this.logger.error(
                        `Could not register the failure of message ${message.message_id}: ` +
                            (dbError instanceof Error ? dbError.message : String(dbError)),
                    );
                }
                continue;
            }

            // Published. A failure to mark it is NOT a publish failure: it must not count as an attempt
            // (nor end in a false alert). The lease expires and the message is published again; the
            // consumers deduplicate by messageId.
            try {
                await this.markSent(message);
                result.sent++;
            } catch (dbError) {
                this.logger.error(
                    `Message ${message.message_id} was published but could not be marked as sent: ` +
                        (dbError instanceof Error ? dbError.message : String(dbError)),
                );
            }
        }
        return result;
    }

    private async claim(): Promise<ClaimedMessage[]> {
        const result: unknown = await this.dataSource.query(
            `UPDATE outbound_messages
                SET next_attempt_at = NOW() + make_interval(secs => $1::int), updated_at = NOW()
              WHERE message_id IN (
                    SELECT message_id FROM outbound_messages
                     WHERE status = 'pending' AND next_attempt_at <= NOW()
                     ORDER BY next_attempt_at, created_at
                     LIMIT $2
                       FOR UPDATE SKIP LOCKED)
          RETURNING message_id, type, payload, attempts, created_at,
                    EXTRACT(EPOCH FROM (NOW() - created_at)) AS age_seconds`,
            [this.config.effectiveLeaseSeconds, this.config.batchSize],
        );
        // An UPDATE ... RETURNING comes back as [rows, affectedCount] with the postgres driver.
        const rows = (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result) as ClaimedMessage[];
        // RETURNING has no order: publish the oldest first so messages of one entity go out in order.
        return [...rows].sort((a, b) => Number(new Date(a.created_at)) - Number(new Date(b.created_at)));
    }

    private async publishWithTimeout(message: ClaimedMessage): Promise<void> {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new Error(`Publish timed out after ${this.config.publishTimeoutMs} ms.`)),
                this.config.publishTimeoutMs,
            );
        });
        try {
            await Promise.race([this.bus.publish(message.type, message.payload), timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    private async markSent(message: ClaimedMessage): Promise<void> {
        await this.dataSource.query(
            `UPDATE outbound_messages
                SET status = 'sent', attempts = $2, updated_at = NOW()
              WHERE message_id = $1 AND status = 'pending'`,
            [message.message_id, message.attempts + 1],
        );
    }

    /**
     * `retried`: another attempt was scheduled. `failed`: the message was given up on and left in
     * `failed`. `ignored`: it was no longer pending (another instance resolved it).
     *
     * Fast phase: 1 s, 2 s and 4 s after the first three failures; the third also writes a single
     * `outbound_message_delayed` alert. Slow phase: one attempt every `slowRetrySeconds` until the
     * message is older than `giveUpAfterMinutes`.
     */
    private async registerFailure(message: ClaimedMessage, detail: string): Promise<'retried' | 'failed' | 'ignored'> {
        const attempts = message.attempts + 1;
        const fastAttempts = OUTBOX_RETRY_DELAYS_MS.length;
        const givenUp = attempts > fastAttempts && Number(message.age_seconds) >= this.config.giveUpAfterMinutes * 60;
        if (givenUp) return await this.giveUp(message, attempts, detail);

        const delayMs =
            attempts <= fastAttempts ? OUTBOX_RETRY_DELAYS_MS[attempts - 1] : this.config.slowRetrySeconds * 1000;
        const delayedAlert = attempts === fastAttempts;

        // One statement: the new schedule and, when the fast phase ends, its alert are atomic, and the
        // alert exists only if THIS call rescheduled the message.
        const rows: unknown[] = await this.dataSource.query(
            `WITH scheduled AS (
                 UPDATE outbound_messages
                    SET attempts = $2, next_attempt_at = NOW() + make_interval(secs => $3::double precision),
                        updated_at = NOW()
                  WHERE message_id = $1 AND status = 'pending'
              RETURNING message_id),
             alerted AS (
                 INSERT INTO audit_logs (user_id, action, detail)
                 SELECT NULL, $4, $5 FROM scheduled WHERE $6::boolean
              RETURNING audit_log_id)
             SELECT message_id FROM scheduled`,
            [
                message.message_id,
                attempts,
                delayMs / 1000,
                OUTBOUND_MESSAGE_DELAYED_ACTION,
                JSON.stringify({ messageId: message.message_id, type: message.type, attempts, lastError: detail }),
                delayedAlert,
            ],
        );
        if (rows.length === 0) return 'ignored';

        const text =
            `Message ${message.message_id} (${message.type}) not published, attempt ${attempts}; ` +
            `retrying in ${delayMs} ms: ${detail}`;
        if (delayedAlert) {
            this.logger.error(`${text} -- the broker looks down, retrying every ${this.config.slowRetrySeconds} s.`);
        } else {
            this.logger.warn(text);
        }
        return 'retried';
    }

    /** Terminal failure: one statement, so the status change and the alert are atomic. */
    private async giveUp(message: ClaimedMessage, attempts: number, detail: string): Promise<'failed' | 'ignored'> {
        const alerts: unknown[] = await this.dataSource.query(
            `WITH failed AS (
                 UPDATE outbound_messages
                    SET status = 'failed', attempts = $2, updated_at = NOW()
                  WHERE message_id = $1 AND status = 'pending'
              RETURNING message_id)
             INSERT INTO audit_logs (user_id, action, detail)
             SELECT NULL, $3, $4 FROM failed
             RETURNING audit_log_id`,
            [
                message.message_id,
                attempts,
                OUTBOUND_MESSAGE_FAILED_ACTION,
                JSON.stringify({ messageId: message.message_id, type: message.type, attempts, lastError: detail }),
            ],
        );
        if (alerts.length === 0) return 'ignored';

        this.logger.error(
            `Message ${message.message_id} (${message.type}) FAILED after ${attempts} attempts and ` +
                `${this.config.giveUpAfterMinutes} min: ${detail}`,
        );
        return 'failed';
    }
}
