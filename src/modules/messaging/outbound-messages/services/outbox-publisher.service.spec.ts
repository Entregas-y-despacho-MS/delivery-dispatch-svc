import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import {
    OUTBOUND_MESSAGE_DELAYED_ACTION,
    OUTBOUND_MESSAGE_FAILED_ACTION,
    OutboxPublisherConfig,
} from './outbox-publisher.config.js';
import { OutboxPublisherService } from './outbox-publisher.service.js';

const MESSAGE_ID = '0192f1e2-7c3a-7b41-9a1e-5d2f0c8e4a10';
const OTHER_ID = '0192f1e2-7c3a-7b41-9a1e-5d2f0c8e4a11';
const TYPE = 'dispatch.shipment.departed';
const MINUTE = 60;

const envelope = (): MessageEnvelope => ({
    messageId: MESSAGE_ID,
    type: TYPE,
    schemaVersion: 1,
    source: 'dispatch',
    occurredAt: '2026-10-11T14:00:00.000Z',
    data: { salesOrderId: 'SO-1' },
});

const config = (overrides: Record<string, number> = {}): OutboxPublisherConfig =>
    Object.assign(
        new OutboxPublisherConfig({
            get: (key: string) =>
                ({
                    OUTBOX_POLL_INTERVAL_MS: 0,
                    OUTBOX_SLOW_RETRY_SECONDS: 60,
                    OUTBOX_GIVE_UP_AFTER_MINUTES: 240,
                    OUTBOX_BATCH_SIZE: 20,
                    OUTBOX_LEASE_SECONDS: 60,
                    OUTBOX_PUBLISH_TIMEOUT_MS: 1000,
                })[key],
        } as never),
        overrides,
    );

type Row = {
    message_id: string;
    type: string;
    payload: MessageEnvelope;
    attempts: number;
    created_at: string;
    age_seconds: number;
};
const row = (id: string, attempts = 0, ageSeconds = 1, createdAt = '2026-10-11T14:00:00.000Z'): Row => ({
    message_id: id,
    type: TYPE,
    payload: envelope(),
    attempts,
    created_at: createdAt,
    age_seconds: ageSeconds,
});

describe('OutboxPublisherService', () => {
    let claimed: Row[];
    let statements: { sql: string; params: unknown[] }[];
    let stillPending: boolean;
    let dataSource: { query: ReturnType<typeof vi.fn> };
    let bus: { publish: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };

    const service = (cfg = config()) => new OutboxPublisherService(dataSource as never, bus as never, cfg);
    const statement = (fragment: string) => statements.find((s) => s.sql.includes(fragment));
    const schedule = () => statement('WITH scheduled AS');
    const giveUp = () => statement('WITH failed AS');

    beforeEach(() => {
        claimed = [row(MESSAGE_ID)];
        statements = [];
        stillPending = true;
        dataSource = {
            query: vi.fn(async (sql: string, params: unknown[] = []) => {
                statements.push({ sql, params });
                // The claim is an UPDATE ... RETURNING, which the driver returns as [rows, affectedCount].
                if (sql.includes('FOR UPDATE SKIP LOCKED')) return [claimed, claimed.length];
                // The failure statements return a row only when the message was still pending.
                if (sql.includes('WITH scheduled AS')) return stillPending ? [{ message_id: params[0] }] : [];
                if (sql.includes('WITH failed AS')) return stillPending ? [{ audit_log_id: 1 }] : [];
                return [];
            }),
        };
        bus = { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() };
    });

    it('publishes the stored envelope to the topic of its type and marks it as sent', async () => {
        const result = await service().publishPending();

        expect(bus.publish).toHaveBeenCalledWith(TYPE, envelope());
        expect(result).toEqual({ sent: 1, retried: 0, failed: 0 });
        expect(statement("status = 'sent'")?.params).toEqual([MESSAGE_ID, 1]);
    });

    it('does nothing when no message is due', async () => {
        claimed = [];

        const result = await service().publishPending();

        expect(bus.publish).not.toHaveBeenCalled();
        expect(result).toEqual({ sent: 0, retried: 0, failed: 0 });
    });

    it('also understands a driver that returns the claimed rows directly', async () => {
        dataSource.query.mockImplementation(async (sql: string) =>
            sql.includes('FOR UPDATE SKIP LOCKED') ? claimed : [],
        );

        const result = await service().publishPending();

        expect(result.sent).toBe(1);
    });

    it('publishes the oldest message first', async () => {
        claimed = [
            row(OTHER_ID, 0, 1, '2026-10-11T14:00:05.000Z'),
            row(MESSAGE_ID, 0, 1, '2026-10-11T14:00:01.000Z'),
        ];

        await service().publishPending();

        expect(statements.filter((s) => s.sql.includes("status = 'sent'")).map((s) => s.params[0])).toEqual([
            MESSAGE_ID,
            OTHER_ID,
        ]);
    });

    describe('when the broker fails', () => {
        beforeEach(() => {
            bus.publish.mockRejectedValue(new Error('broker down'));
        });

        it.each([
            [0, 1, 1],
            [1, 2, 2],
            [2, 3, 4],
        ])('after %i previous failures waits %i s... (failure %i) ', async (previous, failure, seconds) => {
            claimed = [row(MESSAGE_ID, previous)];

            const result = await service().publishPending();

            expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });
            expect(schedule()?.params.slice(0, 3)).toEqual([MESSAGE_ID, failure, seconds]);
        });

        it('writes a single "delayed" alert when the fast phase ends (3rd failure)', async () => {
            claimed = [row(MESSAGE_ID, 2)];

            await service().publishPending();

            const params = schedule()!.params;
            expect(params[3]).toBe(OUTBOUND_MESSAGE_DELAYED_ACTION);
            expect(params[5]).toBe(true);
            expect(JSON.parse(params[4] as string)).toMatchObject({ messageId: MESSAGE_ID, type: TYPE, attempts: 3 });
        });

        it('does not write the alert on the first two failures', async () => {
            for (const previous of [0, 1]) {
                statements = [];
                claimed = [row(MESSAGE_ID, previous)];
                await service().publishPending();
                expect(schedule()?.params[5]).toBe(false);
            }
        });

        it('keeps retrying every slowRetrySeconds after the fast phase, without another alert', async () => {
            claimed = [row(MESSAGE_ID, 3, 30 * MINUTE)];

            const result = await service().publishPending();

            expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });
            expect(schedule()?.params.slice(0, 3)).toEqual([MESSAGE_ID, 4, 60]);
            expect(schedule()?.params[5]).toBe(false);
            expect(giveUp()).toBeUndefined();
        });

        it('keeps retrying until the message is older than giveUpAfterMinutes', async () => {
            claimed = [row(MESSAGE_ID, 50, 239 * MINUTE)];

            const result = await service().publishPending();

            expect(result.retried).toBe(1);
            expect(giveUp()).toBeUndefined();
        });

        it('leaves the message failed and writes the alert in the same statement once the window is over', async () => {
            claimed = [row(MESSAGE_ID, 50, 240 * MINUTE)];

            const result = await service().publishPending();

            expect(result).toEqual({ sent: 0, retried: 0, failed: 1 });
            const alert = giveUp()!;
            expect(alert.sql).toContain("status = 'failed'");
            expect(alert.params.slice(0, 3)).toEqual([MESSAGE_ID, 51, OUTBOUND_MESSAGE_FAILED_ACTION]);
            expect(JSON.parse(alert.params[3] as string)).toEqual({
                messageId: MESSAGE_ID,
                type: TYPE,
                attempts: 51,
                lastError: 'broker down',
            });
            expect(schedule()).toBeUndefined();
        });

        it('never gives up during the fast phase, however old the message is', async () => {
            claimed = [row(MESSAGE_ID, 0, 24 * 60 * MINUTE)];

            const result = await service().publishPending();

            expect(result.retried).toBe(1);
            expect(giveUp()).toBeUndefined();
        });

        it('does not count a failure for a message that another instance already resolved', async () => {
            claimed = [row(MESSAGE_ID, 50, 240 * MINUTE)];
            stillPending = false;

            const result = await service().publishPending();

            expect(result).toEqual({ sent: 0, retried: 0, failed: 0 });
        });

        it('counts a publish that never answers as a failed attempt', async () => {
            bus.publish.mockImplementation(() => new Promise(() => undefined));

            const result = await service(config({ publishTimeoutMs: 20 })).publishPending();

            expect(result.retried).toBe(1);
        });

        it('keeps going with the next message when one fails', async () => {
            claimed = [row(MESSAGE_ID), row(OTHER_ID)];
            bus.publish.mockRejectedValueOnce(new Error('broker down')).mockResolvedValueOnce(undefined);

            const result = await service().publishPending();

            expect(result).toEqual({ sent: 1, retried: 1, failed: 0 });
        });

        it('continues with the batch when registering a failure also fails', async () => {
            claimed = [row(MESSAGE_ID), row(OTHER_ID)];
            bus.publish.mockRejectedValueOnce(new Error('broker down')).mockResolvedValueOnce(undefined);
            dataSource.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
                statements.push({ sql, params });
                if (sql.includes('FOR UPDATE SKIP LOCKED')) return [claimed, claimed.length];
                if (sql.includes('WITH scheduled AS')) throw new Error('database down');
                return [];
            });

            const result = await service().publishPending();

            expect(bus.publish).toHaveBeenCalledTimes(2);
            expect(result.sent).toBe(1);
        });
    });

    it('does not count a failed "mark as sent" as a publish attempt nor raise an alert', async () => {
        dataSource.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
            statements.push({ sql, params });
            if (sql.includes('FOR UPDATE SKIP LOCKED')) return [claimed, claimed.length];
            if (sql.includes("status = 'sent'")) throw new Error('database blip');
            return [];
        });

        const result = await service().publishPending();

        expect(bus.publish).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ sent: 0, retried: 0, failed: 0 });
        expect(schedule()).toBeUndefined();
        expect(giveUp()).toBeUndefined();
    });

    it('shares the run in progress between overlapping calls', async () => {
        const publisher = service();

        const [first, second] = await Promise.all([publisher.publishPending(), publisher.publishPending()]);

        expect(second).toBe(first);
        expect(bus.publish).toHaveBeenCalledTimes(1);
    });

    it('keeps the lease longer than the worst case of a whole batch', () => {
        expect(config({ batchSize: 20, publishTimeoutMs: 10000, leaseSeconds: 60 }).effectiveLeaseSeconds).toBe(205);
        expect(config({ batchSize: 2, publishTimeoutMs: 1000, leaseSeconds: 60 }).effectiveLeaseSeconds).toBe(60);
    });
});
