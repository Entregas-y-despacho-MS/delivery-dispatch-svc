import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildEnvelope, type MessageEnvelope } from '../../../plugins/messaging/envelope/message-envelope.js';
import { MessageValidator } from '../../../plugins/messaging/envelope/message-validator.js';
import { generateMessageId } from '../../../plugins/messaging/envelope/uuid-v7.js';
import { MemoryMessageBusAdapter } from '../../../plugins/messaging/memory/memory-message-bus.adapter.js';
import { InboundMessage } from '../inbound-messages/entities/inbound-message.entity.js';
import { InboundMessagesService } from '../inbound-messages/services/inbound-messages.service.js';
import { OutboundMessage } from './entities/outbound-message.entity.js';
import { OUTBOUND_MESSAGE_FAILED_ACTION, OutboxPublisherConfig } from './services/outbox-publisher.config.js';
import { OutboxPublisherService } from './services/outbox-publisher.service.js';
import { OutboxService } from './services/outbox.service.js';

/**
 * Against a real PostgreSQL with the delivery-dispatch-db schema loaded. Skipped unless TEST_DB_PORT is set:
 *   TEST_DB_HOST=localhost TEST_DB_PORT=5432 TEST_DB_USER=... TEST_DB_PASSWORD=... TEST_DB_NAME=... \
 *     npx vitest run outbox.integration
 * It only touches the rows it creates and removes them afterwards.
 */
const PORT = process.env.TEST_DB_PORT;
const CONTRACTS_DIR = resolve(process.cwd(), 'contracts/messages');
const DEPARTED = 'dispatch.shipment.departed';
const READY = 'inventory.shipment.ready';

const exampleData = (topic: string): Record<string, unknown> =>
    (JSON.parse(readFileSync(resolve(CONTRACTS_DIR, 'examples', `${topic}.example.json`), 'utf8')) as MessageEnvelope).data;

/** The real config class (its lease is derived from the batch size), fed by a plain getter. */
const config = (overrides: Record<string, number> = {}): OutboxPublisherConfig =>
    Object.assign(
        new OutboxPublisherConfig({
            get: (key: string) =>
                ({
                    OUTBOX_POLL_INTERVAL_MS: 0,
                    OUTBOX_MAX_ATTEMPTS: 3,
                    OUTBOX_BATCH_SIZE: 20,
                    OUTBOX_LEASE_SECONDS: 60,
                    OUTBOX_PUBLISH_TIMEOUT_MS: 2000,
                })[key],
        } as never),
        overrides,
    );

describe.skipIf(!PORT)('outbox against PostgreSQL', () => {
    let dataSource: DataSource;
    const validator = MessageValidator.fromDirectory(CONTRACTS_DIR);
    const created: string[] = [];

    const newDeparted = (): MessageEnvelope => {
        const envelope = buildEnvelope({ type: DEPARTED, source: 'dispatch', data: exampleData(DEPARTED) });
        created.push(envelope.messageId);
        return envelope;
    };
    const outbox = () => new OutboxService(dataSource, validator);
    const brokerThatWorks = () => ({ publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() });
    const publisher = (bus: { publish: unknown }, cfg = config()) =>
        new OutboxPublisherService(dataSource, bus as never, cfg);
    const row = async (messageId: string) =>
        (
            (await dataSource.query(
                `SELECT status, attempts, next_attempt_at > NOW() AS waiting FROM outbound_messages WHERE message_id = $1`,
                [messageId],
            )) as { status: string; attempts: number; waiting: boolean }[]
        )[0];
    const makeDue = async (messageId: string) =>
        await dataSource.query(`UPDATE outbound_messages SET next_attempt_at = NOW() - interval '1 second' WHERE message_id = $1`, [
            messageId,
        ]);

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'postgres',
            host: process.env.TEST_DB_HOST ?? 'localhost',
            port: Number(PORT),
            username: process.env.TEST_DB_USER,
            password: process.env.TEST_DB_PASSWORD,
            database: process.env.TEST_DB_NAME,
            entities: [OutboundMessage, InboundMessage],
        });
        await dataSource.initialize();
    });

    afterEach(async () => {
        await dataSource.query(`DELETE FROM outbound_messages WHERE message_id = ANY($1::uuid[])`, [created]);
        await dataSource.query(`DELETE FROM inbound_messages WHERE message_id = ANY($1::uuid[])`, [created]);
        await dataSource.query(`DELETE FROM audit_logs WHERE action = $1 AND detail LIKE ANY($2::text[])`, [
            OUTBOUND_MESSAGE_FAILED_ACTION,
            created.map((id) => `%${id}%`),
        ]);
        created.length = 0;
    });

    afterAll(async () => {
        await dataSource?.destroy();
    });

    it('does not leave a message behind when the business transaction rolls back', async () => {
        const envelope = newDeparted();

        await expect(
            dataSource.transaction(async (manager) => {
                await outbox().enqueue(envelope, { manager });
                throw new Error('business failure');
            }),
        ).rejects.toThrow('business failure');

        expect(await row(envelope.messageId)).toBeUndefined();
    });

    it('queues the message when the business transaction commits, once per messageId', async () => {
        const envelope = newDeparted();

        await dataSource.transaction(async (manager) => {
            await outbox().enqueue(envelope, { manager });
        });
        const again = await outbox().enqueue(envelope);

        expect(again).toBe(false);
        expect(await row(envelope.messageId)).toMatchObject({ status: 'pending', attempts: 0 });
    });

    it('publishes a pending message, marks it sent and does not publish it again', async () => {
        const envelope = newDeparted();
        await outbox().enqueue(envelope);
        const bus = brokerThatWorks();

        const first = await publisher(bus).publishPending();
        const second = await publisher(bus).publishPending();

        expect(first.sent).toBeGreaterThanOrEqual(1);
        expect(second.sent).toBe(0);
        expect(bus.publish).toHaveBeenCalledTimes(1);
        expect(bus.publish).toHaveBeenCalledWith(DEPARTED, expect.objectContaining({ messageId: envelope.messageId }));
        expect(await row(envelope.messageId)).toMatchObject({ status: 'sent', attempts: 1 });
    });

    it('survives a broker outage: retries with a wait, then publishes when the broker is back', async () => {
        const envelope = newDeparted();
        await outbox().enqueue(envelope);
        const bus = { publish: vi.fn().mockRejectedValue(new Error('broker down')), subscribe: vi.fn() };

        const outage = await publisher(bus).publishPending();
        expect(outage.retried).toBe(1);
        expect(await row(envelope.messageId)).toMatchObject({ status: 'pending', attempts: 1, waiting: true });

        // Still waiting: not claimed again before next_attempt_at.
        await publisher(bus).publishPending();
        expect(bus.publish).toHaveBeenCalledTimes(1);

        // Broker restored and the wait elapsed.
        bus.publish.mockResolvedValue(undefined);
        await makeDue(envelope.messageId);
        await publisher(bus).publishPending();

        expect(bus.publish).toHaveBeenCalledTimes(2);
        expect(await row(envelope.messageId)).toMatchObject({ status: 'sent', attempts: 2 });
    });

    it('leaves the message failed and writes an alert in audit_logs after 3 failed attempts', async () => {
        const envelope = newDeparted();
        await outbox().enqueue(envelope);
        const bus = { publish: vi.fn().mockRejectedValue(new Error('broker down')), subscribe: vi.fn() };

        for (let attempt = 1; attempt <= 3; attempt++) {
            await publisher(bus).publishPending();
            await makeDue(envelope.messageId);
        }

        expect(await row(envelope.messageId)).toMatchObject({ status: 'failed', attempts: 3 });
        const alerts = (await dataSource.query(`SELECT user_id, detail FROM audit_logs WHERE action = $1 AND detail LIKE $2`, [
            OUTBOUND_MESSAGE_FAILED_ACTION,
            `%${envelope.messageId}%`,
        ])) as { user_id: number | null; detail: string }[];
        expect(alerts).toHaveLength(1);
        expect(alerts[0].user_id).toBeNull();
        expect(JSON.parse(alerts[0].detail)).toMatchObject({ messageId: envelope.messageId, type: DEPARTED, attempts: 3 });

        // `failed` is terminal: it is never claimed again.
        bus.publish.mockClear();
        await publisher(bus).publishPending();
        expect(bus.publish).not.toHaveBeenCalledWith(DEPARTED, expect.objectContaining({ messageId: envelope.messageId }));
    });

    it('lets two publishers work at the same time without publishing a message twice', async () => {
        const envelopes = Array.from({ length: 6 }, newDeparted);
        for (const envelope of envelopes) await outbox().enqueue(envelope);
        const published: string[] = [];
        const bus = {
            publish: vi.fn(async (_topic: string, message: MessageEnvelope) => {
                await new Promise((done) => setTimeout(done, 20));
                published.push(message.messageId);
            }),
            subscribe: vi.fn(),
        };

        await Promise.all([
            publisher(bus, config({ batchSize: 3 })).publishPending(),
            publisher(bus, config({ batchSize: 3 })).publishPending(),
        ]);

        const mine = published.filter((id) => created.includes(id));
        expect(new Set(mine).size).toBe(mine.length);
        expect(mine.length).toBeGreaterThanOrEqual(1);
    });

    it('records receipts once and keeps the first one', async () => {
        const log = new InboundMessagesService(dataSource.getRepository(InboundMessage), dataSource);
        const messageId = generateMessageId();
        created.push(messageId);

        const first = await log.record({ messageId, status: 'processed', type: READY, source: 'inventory' });
        const second = await log.record({
            messageId,
            status: 'rejected',
            type: READY,
            source: 'inventory',
            errorDetail: 'late',
        });

        expect(first).toBe(true);
        expect(second).toBe(false);
        expect(await log.wasProcessed(messageId)).toBe(true);
        const [stored] = (await dataSource.query(`SELECT status, error_detail FROM inbound_messages WHERE message_id = $1`, [
            messageId,
        ])) as { status: string; error_detail: string | null }[];
        expect(stored).toEqual({ status: 'processed', error_detail: null });
    });

    it('ignores a repeated incoming message through the database receipt log', async () => {
        const log = new InboundMessagesService(dataSource.getRepository(InboundMessage), dataSource);
        const bus = new MemoryMessageBusAdapter(validator, log);
        const handler = vi.fn().mockResolvedValue(undefined);
        await bus.subscribe(READY, handler);
        const message = buildEnvelope({ type: READY, source: 'inventory', data: exampleData(READY) });
        created.push(message.messageId);

        await bus.publish(READY, message);
        // A new bus instance (a restarted service) still knows the message: the receipt is in the database.
        const restarted = new MemoryMessageBusAdapter(validator, log);
        await restarted.subscribe(READY, handler);
        const outcome = await restarted.publishRaw(READY, message);

        expect(outcome).toBe('duplicate');
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('stores a rejected incoming message with its errors', async () => {
        const log = new InboundMessagesService(dataSource.getRepository(InboundMessage), dataSource);
        const bus = new MemoryMessageBusAdapter(validator, log);
        await bus.subscribe(READY, vi.fn());
        const message = buildEnvelope({ type: READY, source: 'inventory', data: {} });
        created.push(message.messageId);

        const outcome = await bus.publishRaw(READY, message);

        expect(outcome).toBe('rejected');
        const [stored] = (await dataSource.query(`SELECT status, error_detail FROM inbound_messages WHERE message_id = $1`, [
            message.messageId,
        ])) as { status: string; error_detail: string }[];
        expect(stored.status).toBe('rejected');
        expect(JSON.parse(stored.error_detail).length).toBeGreaterThan(0);
    });
});
