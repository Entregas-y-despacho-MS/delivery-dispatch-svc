import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import { OUTBOUND_MESSAGE_FAILED_ACTION, type OutboxPublisherConfig } from './outbox-publisher.config.js';
import { OutboxPublisherService } from './outbox-publisher.service.js';

const MESSAGE_ID = '0192f1e2-7c3a-7b41-9a1e-5d2f0c8e4a10';
const TYPE = 'dispatch.shipment.departed';

const envelope = (): MessageEnvelope => ({
    messageId: MESSAGE_ID,
    type: TYPE,
    schemaVersion: 1,
    source: 'dispatch',
    occurredAt: '2026-10-11T14:00:00.000Z',
    data: { salesOrderId: 'SO-1' },
});

const config = (overrides: Partial<OutboxPublisherConfig> = {}): OutboxPublisherConfig =>
    ({
        pollIntervalMs: 0,
        maxAttempts: 3,
        batchSize: 20,
        leaseSeconds: 60,
        publishTimeoutMs: 1000,
        ...overrides,
    }) as OutboxPublisherConfig;

describe('OutboxPublisherService', () => {
    let claimed: { message_id: string; type: string; payload: MessageEnvelope; attempts: number }[];
    let statements: { sql: string; params: unknown[] }[];
    let transactionStatements: { sql: string; params: unknown[] }[];
    let dataSource: { query: ReturnType<typeof vi.fn>; transaction: ReturnType<typeof vi.fn> };
    let bus: { publish: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };

    const service = (cfg = config()) => new OutboxPublisherService(dataSource as never, bus as never, cfg);

    beforeEach(() => {
        claimed = [{ message_id: MESSAGE_ID, type: TYPE, payload: envelope(), attempts: 0 }];
        statements = [];
        transactionStatements = [];
        dataSource = {
            query: vi.fn(async (sql: string, params: unknown[] = []) => {
                statements.push({ sql, params });
                // UPDATE ... RETURNING comes back as [rows, affectedCount].
                return sql.includes('RETURNING') ? [claimed, claimed.length] : [];
            }),
            transaction: vi.fn(async (work: (manager: unknown) => Promise<void>) => {
                await work({
                    query: async (sql: string, params: unknown[] = []) => {
                        transactionStatements.push({ sql, params });
                        return [];
                    },
                });
            }),
        };
        bus = { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() };
    });

    const update = (fragment: string) => statements.find((s) => s.sql.includes(fragment) && !s.sql.includes('RETURNING'));

    it('publishes the stored envelope to the topic of its type and marks it as sent', async () => {
        const result = await service().publishPending();

        expect(bus.publish).toHaveBeenCalledWith(TYPE, envelope());
        expect(result).toEqual({ sent: 1, retried: 0, failed: 0 });
        expect(update("status = 'sent'")?.params).toEqual([MESSAGE_ID, 1]);
    });

    it('does nothing when no message is due', async () => {
        claimed = [];

        const result = await service().publishPending();

        expect(bus.publish).not.toHaveBeenCalled();
        expect(result).toEqual({ sent: 0, retried: 0, failed: 0 });
    });

    it('also understands a driver that returns the claimed rows directly', async () => {
        dataSource.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
            statements.push({ sql, params });
            return sql.includes('RETURNING') ? claimed : [];
        });

        const result = await service().publishPending();

        expect(result.sent).toBe(1);
    });

    it('schedules the first retry in 1 s when the broker fails', async () => {
        bus.publish.mockRejectedValue(new Error('broker down'));

        const result = await service().publishPending();

        expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });
        const retry = update('next_attempt_at = NOW() + make_interval(secs => $3');
        expect(retry?.params).toEqual([MESSAGE_ID, 1, 1]);
        expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('schedules the second retry in 2 s', async () => {
        claimed[0].attempts = 1;
        bus.publish.mockRejectedValue(new Error('broker down'));

        await service().publishPending();

        expect(update('next_attempt_at = NOW() + make_interval(secs => $3')?.params).toEqual([MESSAGE_ID, 2, 2]);
    });

    it('uses 4 s as the third wait when more attempts are allowed', async () => {
        claimed[0].attempts = 2;
        bus.publish.mockRejectedValue(new Error('broker down'));

        await service(config({ maxAttempts: 4 })).publishPending();

        expect(update('next_attempt_at = NOW() + make_interval(secs => $3')?.params).toEqual([MESSAGE_ID, 3, 4]);
    });

    it('leaves the message failed and writes an alert in audit_logs after the last attempt', async () => {
        claimed[0].attempts = 2;
        bus.publish.mockRejectedValue(new Error('broker down'));

        const result = await service().publishPending();

        expect(result).toEqual({ sent: 0, retried: 0, failed: 1 });
        const [failure, alert] = transactionStatements;
        expect(failure.sql).toContain("status = 'failed'");
        expect(failure.params).toEqual([MESSAGE_ID, 3]);
        expect(alert.sql).toContain('INSERT INTO audit_logs');
        expect(alert.params[0]).toBe(OUTBOUND_MESSAGE_FAILED_ACTION);
        expect(JSON.parse(alert.params[1] as string)).toEqual({
            messageId: MESSAGE_ID,
            type: TYPE,
            attempts: 3,
            lastError: 'broker down',
        });
    });

    it('counts a publish that never answers as a failed attempt', async () => {
        bus.publish.mockImplementation(() => new Promise(() => undefined));

        const result = await service(config({ publishTimeoutMs: 20 })).publishPending();

        expect(result.retried).toBe(1);
    });

    it('keeps going with the next message when one fails', async () => {
        const other = { message_id: '0192f1e2-7c3a-7b41-9a1e-5d2f0c8e4a11', type: TYPE, payload: envelope(), attempts: 0 };
        claimed.push(other);
        bus.publish.mockRejectedValueOnce(new Error('broker down')).mockResolvedValueOnce(undefined);

        const result = await service().publishPending();

        expect(result).toEqual({ sent: 1, retried: 1, failed: 0 });
    });

    it('shares the run in progress between overlapping calls', async () => {
        const publisher = service();

        const [first, second] = await Promise.all([publisher.publishPending(), publisher.publishPending()]);

        expect(second).toBe(first);
        expect(bus.publish).toHaveBeenCalledTimes(1);
    });
});
