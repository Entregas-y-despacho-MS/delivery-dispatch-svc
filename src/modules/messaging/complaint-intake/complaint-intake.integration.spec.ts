import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageValidator } from '../../../plugins/messaging/envelope/message-validator.js';
import type { MessageEnvelope } from '../../../plugins/messaging/envelope/message-envelope.js';
import { INBOUND_MESSAGE_REJECTED_EVENT } from '../../../plugins/messaging/inbound-message-rejection.port.js';
import { MemoryInboundMessageLogAdapter } from '../../../plugins/messaging/memory/memory-inbound-message-log.adapter.js';
import { MemoryInboundMessageRejectionAdapter } from '../../../plugins/messaging/memory/memory-inbound-message-rejection.adapter.js';
import { MemoryInboundMessageTransactionAdapter } from '../../../plugins/messaging/memory/memory-inbound-message-transaction.adapter.js';
import { MemoryMessageBusAdapter } from '../../../plugins/messaging/memory/memory-message-bus.adapter.js';
import { InvalidOutboundMessageException } from '../outbound-messages/exceptions/index.js';
import { COMPLAINT_OPENED_TOPIC } from './domain/complaint-message.types.js';
import { ComplaintConsumer } from './services/complaint-consumer.service.js';
import { ComplaintIntakeService } from './services/complaint-intake.service.js';
import { ComplaintRejectionAcknowledger } from './services/complaint-rejection-acknowledger.service.js';

/**
 * ST-298.3 — the invalid-payload circuit with the in-memory adapters (no Docker, no PostgreSQL): message →
 * schema validation → dead-letter → rejection alert → `inbound.message.rejected` →
 * `ComplaintRejectionAcknowledger` → outbox. The outbox here applies the same JSON Schema check as the real one,
 * so what is queued is a valid `dispatch.delivery_complaint.rejected`. The SQL of the intake is covered by
 * `complaint-intake.postgres.integration.spec.ts`.
 */
const CONTRACTS_DIR = resolve(process.cwd(), 'contracts/messages');
const INVALID_DIR = resolve(CONTRACTS_DIR, 'examples/invalid');

interface InvalidExample {
    description: string;
    expectedErrorPath: string;
    message: MessageEnvelope;
}

const examples = readdirSync(INVALID_DIR)
    .filter((file) => file.startsWith('crm.delivery_complaint.opened.'))
    .map((file) => ({ file, example: JSON.parse(readFileSync(resolve(INVALID_DIR, file), 'utf8')) as InvalidExample }));

function wire() {
    const validator = MessageValidator.fromDirectory(CONTRACTS_DIR);
    const events = new EventEmitter2();
    const log = new MemoryInboundMessageLogAdapter();
    const rejection = new MemoryInboundMessageRejectionAdapter(events);
    const bus = new MemoryMessageBusAdapter(validator, log, rejection);
    const queued: MessageEnvelope[] = [];
    const outbox = {
        enqueue: vi.fn(async (envelope: MessageEnvelope) => {
            const result = validator.validate(envelope.type, envelope);
            if (!result.valid) throw new InvalidOutboundMessageException(envelope.type, result.errors);
            queued.push(envelope);
            return true;
        }),
    };
    const acknowledger = new ComplaintRejectionAcknowledger(outbox as never);
    events.on(INBOUND_MESSAGE_REJECTED_EVENT, (notice) => acknowledger.onInboundMessageRejected(notice));
    const transaction = new MemoryInboundMessageTransactionAdapter(log);
    const consumer = new ComplaintConsumer(bus, transaction, new ComplaintIntakeService(outbox as never));
    return { bus, queued, outbox, rejection, consumer };
}

describe('schema_invalid acknowledgement of a CRM complaint, with the in-memory adapters', () => {
    let ctx: ReturnType<typeof wire>;

    beforeEach(async () => {
        ctx = wire();
        await ctx.consumer.onModuleInit();
    });

    it('covers every invalid example of the contract', () => {
        expect(examples.length).toBeGreaterThanOrEqual(9);
    });

    it.each(examples.map(({ file, example }) => [file, example] as const))(
        '%s: dead-letter plus a valid rejected/schema_invalid pointing at the failing field',
        async (_file, example) => {
            const outcome = await ctx.bus.publishRaw(COMPLAINT_OPENED_TOPIC, example.message);

            expect(outcome).toBe('rejected');
            expect(ctx.bus.deadLettersOf(COMPLAINT_OPENED_TOPIC)).toHaveLength(1);
            expect(ctx.queued).toHaveLength(1);
            const ack = ctx.queued[0]!;
            expect(ack).toMatchObject({ type: 'dispatch.delivery_complaint.rejected', source: 'dispatch' });
            expect(ack.data).toMatchObject({ correlationMessageId: example.message.messageId, rejectionCode: 'schema_invalid' });
            expect(typeof ack.data.field).toBe('string');
            expect(ack.data.field as string).toMatch(/^\//);
            // The acknowledgement never echoes the payload: no reason, no items, no references.
            expect(JSON.stringify(ack)).not.toMatch(/DAMAGED_ITEM|PKG-000123|SO-2026-000123/);
        },
    );

    it('keeps the case of a readable payload in the acknowledgement', async () => {
        const { message } = examples.find(({ file }) => file.includes('version-cero'))!.example;

        await ctx.bus.publishRaw(COMPLAINT_OPENED_TOPIC, message);

        // caseVersion 0 is not a valid version: only the case id travels.
        const { data } = ctx.queued[0]!;
        expect(data).toMatchObject({ crmCaseId: 'CRM-CASE-2026-000871', field: '/data/caseVersion' });
        expect(data).not.toHaveProperty('caseVersion');
    });

    it('answers nothing when the message has no usable messageId, but still dead-letters it', async () => {
        const { message } = examples[0]!.example;

        const outcome = await ctx.bus.publishRaw(COMPLAINT_OPENED_TOPIC, { ...message, messageId: 'no-es-un-uuid' });

        expect(outcome).toBe('rejected');
        expect(ctx.bus.deadLettersOf(COMPLAINT_OPENED_TOPIC)).toHaveLength(1);
        expect(ctx.queued).toHaveLength(0);
    });

    it('an invalid payload of another topic gets no acknowledgement from the complaint module', async () => {
        await ctx.bus.subscribe('inventory.shipment.ready', async () => undefined);

        const outcome = await ctx.bus.publishRaw('inventory.shipment.ready', { messageId: '019a8f2c-41d0-7b6e-9c3a-2f7e1d5a8c11', type: 'inventory.shipment.ready' });

        expect(outcome).toBe('rejected');
        expect(ctx.queued).toHaveLength(0);
    });

    it('a failure to queue the acknowledgement does not undo the dead-letter or the rejected receipt', async () => {
        ctx.outbox.enqueue.mockRejectedValue(new Error('outbox unavailable'));
        const { message } = examples[0]!.example;

        const outcome = await ctx.bus.publishRaw(COMPLAINT_OPENED_TOPIC, message);

        expect(outcome).toBe('rejected');
        expect(ctx.bus.deadLettersOf(COMPLAINT_OPENED_TOPIC)).toHaveLength(1);
    });
});
