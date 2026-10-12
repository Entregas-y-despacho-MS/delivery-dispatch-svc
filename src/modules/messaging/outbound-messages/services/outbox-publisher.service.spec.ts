import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import { OUTBOUND_MESSAGE_FAILED_ACTION, OutboxPublisherConfig } from './outbox-publisher.config.js';
import { OutboxPublisherService } from './outbox-publisher.service.js';

const MESSAGE_ID = '0192f1e2-7c3a-7b41-9a1e-5d2f0c8e4a10';
const OTHER_ID = '0192f1e2-7c3a-7b41-9a1e-5d2f0c8e4a11';
const TYPE = 'dispatch.shipment.departed';

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
                    OUTBOX_MAX_ATTEMPTS: 3,
                    OUTBOX_BATCH_SIZE: 20,
                    OUTBOX_LEASE_SECONDS: 60,
                    OUTBOX_PUBLISH_TIMEOUT_MS: 1000,
                })[key],
        } as never),
        overrides,
    );

type Row = { message_id: string; type: string; payload: MessageEnvelope; attempts: number; created_at: string };
const row = (id: string, attempts = 0, createdAt = '2026-10-11T14:00:00.000Z'): Row => ({
    message_id: id,
    type: TYPE,
    payload: envelope(),
    attempts,
    created_at: createdAt,
});

describe('OutboxPublisherService', () => {
    let claimed: Row[];
    let statements: { sql: string; params: unknown[] }[];
    let failureAlertRows: unknown[];
    let dataSource: { query: ReturnType<typeof vi.fn> };
    let bus: { publish: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };

    const service = (cfg = config()) => new OutboxPublisherService(dataSource as never, bus as never, cfg);
    const statement = (fragment: string) => statements.find((s) => s.sql.includes(fragment));

    beforeEach(() => {
        claimed = [row(MESSAGE_ID)];
        statements = [];
        failureAlertRows = [{ audit_log_id: 1 }];
        dataSource = {
            query: vi.fn(async (sql: string, params: unknown[] = []) => {
                statements.push({ sql, params });
                // The claim is an UPDATE ... RETURNING, which the driver returns as [rows, affectedCount].
                if (sql.includes('FOR UPDATE SKIP LOCKED')) return [claimed, claimed.length];
                if (sql.includes('INSERT INTO audit_logs')) return failureAlertRows;
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
        claimed = [row(OTHER_ID, 0, '2026-10-11T14:00:05.000Z'), row(MESSAGE_ID, 0, '2026-10-11T14:00:01.000Z')];
        const order: string[] = [];
        bus.publish.mockImplementation(async (_topic: string) => {
            order.push(String(order.length));
        });

        await service().publishPending();

        expect(statements.filter((s) => s.sql.includes("status = 'sent'")).map((s) => s.params[0])).toEqual([
            MESSAGE_ID,
            OTHER_ID,
        ]);
    });

    it('schedules the first retry in 1 s when the broker fails', async () => {
        bus.publish.mockRejectedValue(new Error('broker down'));

        const result = await service().publishPending();

        expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });
        expect(statement('next_attempt_at = NOW() + make_interval(secs => $3')?.params).toEqual([MESSAGE_ID, 1, 1]);
        expect(statement('INSERT INTO audit_logs')).toBeUndefined();
    });

    it('schedules the second retry in 2 s', async () => {
        claimed = [row(MESSAGE_ID, 1)];
        bus.publish.mockRejectedValue(new Error('broker down'));

        await service().publishPending();

        expect(statement('next_attempt_at = NOW() + make_interval(secs => $3')?.params).toEqual([MESSAGE_ID, 2, 2]);
    });

    it('uses 4 s as the third wait when more attempts are allowed', async () => {
        claimed = [row(MESSAGE_ID, 2)];
        bus.publish.mockRejectedValue(new Error('broker down'));

        await service(config({ maxAttempts: 4 })).publishPending();

        expect(statement('next_attempt_at = NOW() + make_interval(secs => $3')?.params).toEqual([MESSAGE_ID, 3, 4]);
    });

    it('leaves the message failed and writes the alert in the same statement after the last attempt', async () => {
        claimed = [row(MESSAGE_ID, 2)];
        bus.publish.mockRejectedValue(new Error('broker down'));

        const result = await service().publishPending();

        expect(result).toEqual({ sent: 0, retried: 0, failed: 1 });
        const alert = statement('INSERT INTO audit_logs')!;
        expect(alert.sql).toContain("status = 'failed'");
        expect(alert.params.slice(0, 3)).toEqual([MESSAGE_ID, 3, OUTBOUND_MESSAGE_FAILED_ACTION]);
        expect(JSON.parse(alert.params[3] as string)).toEqual({
            messageId: MESSAGE_ID,
            type: TYPE,
            attempts: 3,
            lastError: 'broker down',
        });
    });

    it('does not count a failure for a message that another instance already resolved', async () => {
        claimed = [row(MESSAGE_ID, 2)];
        failureAlertRows = []; // the UPDATE found no pending row, so no alert was inserted
        bus.publish.mockRejectedValue(new Error('broker down'));

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
        expect(statement('make_interval(secs => $3')).toBeUndefined();
        expect(statement('INSERT INTO audit_logs')).toBeUndefined();
    });

    it('continues with the batch when registering a failure also fails', async () => {
        claimed = [row(MESSAGE_ID), row(OTHER_ID)];
        bus.publish.mockRejectedValueOnce(new Error('broker down')).mockResolvedValueOnce(undefined);
        dataSource.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
            statements.push({ sql, params });
            if (sql.includes('FOR UPDATE SKIP LOCKED')) return [claimed, claimed.length];
            if (sql.includes('make_interval(secs => $3')) throw new Error('database down');
            return [];
        });

        const result = await service().publishPending();

        expect(bus.publish).toHaveBeenCalledTimes(2);
        expect(result.sent).toBe(1);
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
