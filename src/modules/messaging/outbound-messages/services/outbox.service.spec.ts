import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildEnvelope, type MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import { MessageValidator } from '../../../../plugins/messaging/envelope/message-validator.js';
import { InvalidOutboundMessageException } from '../exceptions/index.js';
import { OutboxService } from './outbox.service.js';

const CONTRACTS_DIR = resolve(process.cwd(), 'contracts/messages');
const TOPIC = 'dispatch.shipment.departed';
const validator = MessageValidator.fromDirectory(CONTRACTS_DIR);

/** A valid message built from the `data` of the contract example, so the test follows the real schema. */
const validEnvelope = (): MessageEnvelope => {
    const example = JSON.parse(
        readFileSync(resolve(CONTRACTS_DIR, 'examples', `${TOPIC}.example.json`), 'utf8'),
    ) as MessageEnvelope;
    return buildEnvelope({ type: TOPIC, source: 'dispatch', data: example.data });
};

describe('OutboxService', () => {
    it('writes the envelope in the outbox with the transaction manager it receives', async () => {
        const manager = { query: vi.fn().mockResolvedValue([{ message_id: 'x' }]) };
        const dataSource = { manager: { query: vi.fn() } };
        const service = new OutboxService(dataSource as never, validator);
        const envelope = validEnvelope();

        const queued = await service.enqueue(envelope, { manager: manager as never });

        expect(queued).toBe(true);
        expect(manager.query).toHaveBeenCalledTimes(1);
        expect(dataSource.manager.query).not.toHaveBeenCalled();
        const [sql, params] = manager.query.mock.calls[0];
        expect(sql).toContain('INSERT INTO outbound_messages');
        expect(params[0]).toBe(envelope.messageId);
        expect(params[1]).toBe(TOPIC);
        expect(JSON.parse(params[2])).toEqual(envelope);
    });

    it('returns false when the messageId was already queued', async () => {
        const dataSource = { manager: { query: vi.fn().mockResolvedValue([]) } };
        const service = new OutboxService(dataSource as never, validator);

        await expect(service.enqueue(validEnvelope())).resolves.toBe(false);
    });

    it('refuses a message that does not match the schema of its topic and writes nothing', async () => {
        const dataSource = { manager: { query: vi.fn() } };
        const service = new OutboxService(dataSource as never, validator);
        const invalid = buildEnvelope({ type: TOPIC, source: 'dispatch', data: {} });

        await expect(service.enqueue(invalid)).rejects.toThrow(InvalidOutboundMessageException);
        expect(dataSource.manager.query).not.toHaveBeenCalled();
    });
});
