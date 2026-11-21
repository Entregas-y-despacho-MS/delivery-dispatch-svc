import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import type { MessageHandler } from '../../../../plugins/messaging/message-bus.port.js';
import { COMPLAINT_OPENED_TOPIC } from '../domain/complaint-message.types.js';
import { ComplaintConsumer } from './complaint-consumer.service.js';

const data = {
    crmCaseId: 'CRM-CASE-1',
    caseVersion: 1,
    dispatchId: 42,
    reasonCode: 'DAMAGED_ITEM',
    openedAt: '2026-11-20T15:00:00Z',
    affectedItems: [{ packageId: 'PKG-1', quantity: 1 }],
};
const envelope: MessageEnvelope = {
    messageId: '0199f8c0-0000-7000-8000-000000000011',
    type: COMPLAINT_OPENED_TOPIC,
    schemaVersion: 1,
    source: 'crm',
    occurredAt: '2026-11-20T15:00:01Z',
    data,
};

describe('ComplaintConsumer', () => {
    let handler: MessageHandler | undefined;
    const bus = { subscribe: vi.fn(async (_topic: string, h: MessageHandler) => { handler = h; }) };
    const transaction = { process: vi.fn() };
    const intake = { apply: vi.fn() };
    let consumer: ComplaintConsumer;

    beforeEach(async () => {
        vi.clearAllMocks();
        handler = undefined;
        transaction.process.mockImplementation(async (_e: MessageEnvelope, _key: string, handle: (o: object) => Promise<void>) => {
            await handle({ manager: {} });
            return 'receipt-committed';
        });
        intake.apply.mockResolvedValue({ status: 'accepted', dispatchId: 42, caseVersion: 1 });
        consumer = new ComplaintConsumer(bus as never, transaction as never, intake as never);
        await consumer.onModuleInit();
    });

    it('subscribes to the CRM complaint topic', () => {
        expect(bus.subscribe).toHaveBeenCalledWith(COMPLAINT_OPENED_TOPIC, expect.any(Function));
    });

    it('runs the intake inside the transaction, keyed by the functional key of the case', async () => {
        const result = await handler!(envelope);

        expect(result).toBe('receipt-committed');
        expect(transaction.process).toHaveBeenCalledWith(envelope, 'crm-case:crm:CRM-CASE-1', expect.any(Function));
        expect(intake.apply).toHaveBeenCalledWith(envelope, data, { manager: {} });
    });

    it('commits the receipt of a rejection too, so the broker does not redeliver it', async () => {
        intake.apply.mockResolvedValue({ status: 'rejected', code: 'dispatch_not_found' });

        expect(await handler!(envelope)).toBe('receipt-committed');
    });

    it('does not run the intake for a repeated messageId', async () => {
        transaction.process.mockResolvedValue('duplicate');

        expect(await handler!(envelope)).toBe('duplicate');
        expect(intake.apply).not.toHaveBeenCalled();
    });

    it('lets a persistence error reach the broker so it redelivers the message', async () => {
        intake.apply.mockRejectedValue(new Error('connection lost'));

        await expect(handler!(envelope)).rejects.toThrow('connection lost');
    });
});
