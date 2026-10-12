import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PubSub, type Message } from '@google-cloud/pubsub';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeadLetterPayload } from '../dead-letter.js';
import type { MessageEnvelope } from '../envelope/message-envelope.js';
import { MessageValidator } from '../envelope/message-validator.js';
import { generateMessageId } from '../envelope/uuid-v7.js';
import { MemoryInboundMessageLogAdapter } from '../memory/memory-inbound-message-log.adapter.js';
import { PubsubMessageBusAdapter } from './pubsub-message-bus.adapter.js';
import { PubsubMessagingConfig } from './pubsub-messaging.config.js';

/**
 * Against the real Pub/Sub emulator. Skipped unless PUBSUB_EMULATOR_HOST is set:
 *   docker compose up -d pubsub-emulator pubsub-init   (from the workspace root)
 *   PUBSUB_EMULATOR_HOST=localhost:8085 npx vitest run pubsub-message-bus.adapter.integration
 */
const EMULATOR_HOST = process.env.PUBSUB_EMULATOR_HOST;
const PROJECT_ID = process.env.PUBSUB_PROJECT_ID || 'delivery-dispatch-local';
const CONTRACTS_DIR = resolve(process.cwd(), 'contracts/messages');
const TOPIC = 'inventory.shipment.ready';
const DEAD_LETTER_INSPECTION = `${TOPIC}.dead-letter.inspect`;
const WAIT_MS = 15_000;

const validMessage = (): MessageEnvelope => {
    const example = JSON.parse(
        readFileSync(resolve(CONTRACTS_DIR, 'examples', `${TOPIC}.example.json`), 'utf8'),
    ) as MessageEnvelope;
    return { ...example, messageId: generateMessageId() };
};

const until = async (condition: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + WAIT_MS;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
        await new Promise((done) => setTimeout(done, 100));
    }
};

describe.skipIf(!EMULATOR_HOST)('PubsubMessageBusAdapter (Pub/Sub emulator)', () => {
    let client: PubSub;
    let bus: PubsubMessageBusAdapter;
    const handled: string[] = [];
    const deadLetters: { messageId: unknown; payload: DeadLetterPayload }[] = [];

    beforeAll(async () => {
        client = new PubSub({ projectId: PROJECT_ID, apiEndpoint: EMULATOR_HOST, emulatorMode: true });
        const config = Object.assign(Object.create(PubsubMessagingConfig.prototype), {
            projectId: PROJECT_ID,
            emulatorHost: EMULATOR_HOST,
            subscriptionSuffix: 'dispatch-svc',
        }) as PubsubMessagingConfig;
        bus = new PubsubMessageBusAdapter(
            client,
            config,
            MessageValidator.fromDirectory(CONTRACTS_DIR),
            new MemoryInboundMessageLogAdapter(),
        );

        // Reads the dead-letter through its inspection subscription, like an operator would.
        const inspection = client.subscription(DEAD_LETTER_INSPECTION);
        inspection.on('message', (message: Message) => {
            const payload = JSON.parse(message.data.toString('utf8')) as DeadLetterPayload;
            const original = payload.message as { messageId?: unknown } | null;
            deadLetters.push({ messageId: original?.messageId, payload });
            message.ack();
        });

        await bus.subscribe(TOPIC, async (envelope) => {
            handled.push(envelope.messageId);
        });
    });

    afterAll(async () => {
        await bus.onModuleDestroy();
    });

    it('publishes a valid message and delivers it to the handler', async () => {
        const message = validMessage();

        await bus.publish(TOPIC, message);

        await until(() => handled.includes(message.messageId), 'the valid message');
        expect(handled.filter((id) => id === message.messageId)).toHaveLength(1);
    });

    it('sends an invalid message to the dead-letter with the list of errors', async () => {
        const message = validMessage();
        delete (message.data as Record<string, unknown>).packages;

        await client.topic(TOPIC).publishMessage({ json: message });

        await until(
            () => deadLetters.some((entry) => entry.messageId === message.messageId),
            'the message in the dead-letter',
        );
        const { payload } = deadLetters.find((entry) => entry.messageId === message.messageId)!;
        expect(payload.originalTopic).toBe(TOPIC);
        expect(payload.errors.map((error) => error.message).join(' ')).toContain('packages');
        expect(handled).not.toContain(message.messageId);
    });

    it('ignores a message sent twice with the same messageId', async () => {
        const message = validMessage();
        const sentinel = validMessage();

        await bus.publish(TOPIC, message);
        await bus.publish(TOPIC, message);
        await bus.publish(TOPIC, sentinel);

        // Pub/Sub does not guarantee order, so wait for both and give the duplicate time to arrive.
        await until(() => handled.includes(message.messageId) && handled.includes(sentinel.messageId), 'both messages');
        await new Promise((done) => setTimeout(done, 1500));
        expect(handled.filter((id) => id === message.messageId)).toHaveLength(1);
    });
});
