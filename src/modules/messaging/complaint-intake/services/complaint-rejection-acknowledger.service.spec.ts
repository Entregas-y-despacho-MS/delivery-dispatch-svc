import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundRejectionNotice } from '../../../../plugins/messaging/inbound-message-rejection.port.js';
import { InvalidOutboundMessageException } from '../../outbound-messages/exceptions/index.js';
import { COMPLAINT_OPENED_TOPIC } from '../domain/complaint-message.types.js';
import { ComplaintRejectionAcknowledger, rejectionMessageIdFor } from './complaint-rejection-acknowledger.service.js';

const MESSAGE_ID = '0199f8c0-0000-7000-8000-000000000012';

const notice = (over: Partial<InboundRejectionNotice> = {}, message: unknown = undefined): InboundRejectionNotice => ({
    messageId: MESSAGE_ID,
    type: COMPLAINT_OPENED_TOPIC,
    source: 'crm',
    reasonCode: 'schema_invalid',
    rejectedAt: '2026-11-20T15:00:02.000Z',
    errors: [{ path: '/data/affectedItems', keyword: 'minItems', message: 'must NOT have fewer than 1 items' }],
    message: message ?? { messageId: MESSAGE_ID, data: { crmCaseId: 'CRM-CASE-1', caseVersion: 3 } },
    ...over,
});

describe('ComplaintRejectionAcknowledger', () => {
    const enqueue = vi.fn();
    let acknowledger: ComplaintRejectionAcknowledger;

    beforeEach(() => {
        vi.clearAllMocks();
        enqueue.mockResolvedValue(true);
        acknowledger = new ComplaintRejectionAcknowledger({ enqueue } as never);
    });

    it('queues rejected/schema_invalid with the failing field and the case it could read', async () => {
        await acknowledger.onInboundMessageRejected(notice());

        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(enqueue.mock.calls[0]![0]).toMatchObject({
            type: 'dispatch.delivery_complaint.rejected',
            source: 'dispatch',
            data: {
                correlationMessageId: MESSAGE_ID,
                crmCaseId: 'CRM-CASE-1',
                caseVersion: 3,
                rejectionCode: 'schema_invalid',
                field: '/data/affectedItems',
                rejectedAt: '2026-11-20T15:00:02.000Z',
            },
        });
    });

    it('uses a UUID v7-shaped messageId derived from the rejected message, so a redelivery queues the same one', async () => {
        await acknowledger.onInboundMessageRejected(notice());
        await acknowledger.onInboundMessageRejected(notice());

        const [first, second] = enqueue.mock.calls.map(([envelope]) => envelope.messageId);
        expect(first).toBe(second);
        expect(first).toBe(rejectionMessageIdFor(MESSAGE_ID));
        expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(rejectionMessageIdFor('0199f8c0-0000-7000-8000-000000000099')).not.toBe(first);
    });

    it('leaves the case out when the payload has no readable crmCaseId, and caseVersion with it', async () => {
        await acknowledger.onInboundMessageRejected(notice({}, { messageId: MESSAGE_ID, data: { caseVersion: 3 } }));

        const { data } = enqueue.mock.calls[0]![0];
        expect(data).not.toHaveProperty('crmCaseId');
        expect(data).not.toHaveProperty('caseVersion');
    });

    it('leaves caseVersion out when it is not a positive integer', async () => {
        await acknowledger.onInboundMessageRejected(notice({}, { messageId: MESSAGE_ID, data: { crmCaseId: 'CRM-CASE-1', caseVersion: 0 } }));

        const { data } = enqueue.mock.calls[0]![0];
        expect(data).toMatchObject({ crmCaseId: 'CRM-CASE-1' });
        expect(data).not.toHaveProperty('caseVersion');
    });

    it('leaves the field out when the whole message is what is invalid', async () => {
        await acknowledger.onInboundMessageRejected(notice({ errors: [{ path: '', keyword: 'type', message: 'must be object' }] }));

        expect(enqueue.mock.calls[0]![0].data).not.toHaveProperty('field');
    });

    it('retries without the case when the outbox refuses the unreadable crmCaseId', async () => {
        enqueue.mockRejectedValueOnce(new InvalidOutboundMessageException('dispatch.delivery_complaint.rejected', []));

        await acknowledger.onInboundMessageRejected(notice({}, { messageId: MESSAGE_ID, data: { crmCaseId: 'x'.repeat(500), caseVersion: 1 } }));

        expect(enqueue).toHaveBeenCalledTimes(2);
        const { data } = enqueue.mock.calls[1]![0];
        expect(data).not.toHaveProperty('crmCaseId');
        expect(data).not.toHaveProperty('caseVersion');
        expect(data).toMatchObject({ correlationMessageId: MESSAGE_ID, rejectionCode: 'schema_invalid' });
    });

    it('rethrows a failure that is not about the contents, so the consumer logs it', async () => {
        enqueue.mockRejectedValue(new Error('connection lost'));

        await expect(acknowledger.onInboundMessageRejected(notice())).rejects.toThrow('connection lost');
    });

    it('sends nothing when the original message had no usable messageId (the notice carries a fresh one)', async () => {
        await acknowledger.onInboundMessageRejected(notice({}, { messageId: 'not-a-uuid', data: { crmCaseId: 'CRM-CASE-1' } }));
        await acknowledger.onInboundMessageRejected(notice({}, { data: { crmCaseId: 'CRM-CASE-1' } }));

        expect(enqueue).not.toHaveBeenCalled();
    });

    it.each([
        ['another topic', { type: 'inventory.shipment.ready' }],
        ['another reason', { reasonCode: 'unknown_warehouse' as const }],
    ])('ignores a rejection of %s', async (_label, over) => {
        await acknowledger.onInboundMessageRejected(notice(over));

        expect(enqueue).not.toHaveBeenCalled();
    });
});
