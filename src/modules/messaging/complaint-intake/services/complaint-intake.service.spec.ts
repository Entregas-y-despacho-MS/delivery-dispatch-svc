import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import type { DeliveryComplaintOpenedData } from '../domain/complaint-message.types.js';
import { ComplaintIntakeService } from './complaint-intake.service.js';

const MESSAGE_ID = '0199f8c0-0000-7000-8000-000000000010';

const delivered = { dispatch_id: 42, tracking_code: 'DSP-2026-00042', source_order_ref: 'SO-1', status: 'delivered' };

const data = (over: Partial<DeliveryComplaintOpenedData> = {}): DeliveryComplaintOpenedData => ({
    crmCaseId: 'CRM-CASE-1',
    caseVersion: 1,
    dispatchId: 42,
    reasonCode: 'DAMAGED_ITEM',
    openedAt: '2026-11-20T15:00:00Z',
    affectedItems: [{ packageId: 'PKG-1', quantity: 1 }],
    ...over,
});

const envelope = (payload: DeliveryComplaintOpenedData): MessageEnvelope => ({
    messageId: MESSAGE_ID,
    type: 'crm.delivery_complaint.opened',
    schemaVersion: 1,
    source: 'crm',
    occurredAt: '2026-11-20T15:00:01Z',
    data: payload as unknown as Record<string, unknown>,
});

describe('ComplaintIntakeService', () => {
    let existingCase: { case_version: number } | undefined;
    let dispatchRows: Record<string, unknown>[];
    const query = vi.fn();
    const enqueue = vi.fn();
    let service: ComplaintIntakeService;

    const apply = async (payload: DeliveryComplaintOpenedData) =>
        await service.apply(envelope(payload), payload, { manager: { query } as never });
    const sqlOf = (index: number): string => String(query.mock.calls[index]![0]);
    const writes = () => query.mock.calls.filter(([sql]) => /^\s*(INSERT|UPDATE|DELETE)/i.test(String(sql)));

    beforeEach(() => {
        vi.clearAllMocks();
        existingCase = undefined;
        dispatchRows = [delivered];
        enqueue.mockResolvedValue(true);
        query.mockImplementation(async (sql: string) => {
            if (/FROM delivery_complaint_cases/.test(sql)) return existingCase ? [existingCase] : [];
            if (/FROM dispatches/.test(sql)) return dispatchRows;
            return [];
        });
        service = new ComplaintIntakeService({ enqueue } as never);
    });

    it('accepts a delivered dispatch, stores the case once and queues the received acknowledgement', async () => {
        const result = await apply(data({ trackingCode: 'DSP-2026-00042', salesOrderId: 'SO-1' }));

        expect(result).toEqual({ status: 'accepted', dispatchId: 42, caseVersion: 1 });
        const [sql, params] = writes()[0]!;
        expect(sql).toContain('INSERT INTO delivery_complaint_cases');
        expect(params).toEqual(expect.arrayContaining([MESSAGE_ID, 'crm', 'CRM-CASE-1', 1, 42, 'DSP-2026-00042', 'DAMAGED_ITEM']));
        expect(enqueue).toHaveBeenCalledTimes(1);
        const [queued, options] = enqueue.mock.calls[0]!;
        expect(queued).toMatchObject({
            type: 'dispatch.delivery_complaint.received',
            source: 'dispatch',
            data: { correlationMessageId: MESSAGE_ID, crmCaseId: 'CRM-CASE-1', caseVersion: 1, dispatchId: 42, trackingCode: 'DSP-2026-00042' },
        });
        expect(options.manager).toBeDefined();
    });

    it('never writes to dispatches or route batches: only the case is stored', async () => {
        await apply(data());

        expect(writes()).toHaveLength(1);
        expect(writes().every(([sql]) => String(sql).includes('delivery_complaint_cases'))).toBe(true);
    });

    it('resolves the dispatch by tracking code alone', async () => {
        const result = await apply(data({ dispatchId: undefined, trackingCode: 'DSP-2026-00042' }));

        expect(result).toMatchObject({ status: 'accepted', dispatchId: 42 });
    });

    it.each([
        ['an older caseVersion', 2, 1],
        ['the same caseVersion', 2, 2],
    ])('ignores %s without storing or acknowledging anything', async (_label, stored, incoming) => {
        existingCase = { case_version: stored };

        const result = await apply(data({ caseVersion: incoming }));

        expect(result).toEqual({ status: 'ignored' });
        expect(writes()).toHaveLength(0);
        expect(enqueue).not.toHaveBeenCalled();
    });

    it('applies a newer caseVersion over the case in force', async () => {
        existingCase = { case_version: 1 };

        const result = await apply(data({ caseVersion: 2 }));

        expect(result).toEqual({ status: 'accepted', dispatchId: 42, caseVersion: 2 });
        expect(sqlOf(0)).toMatch(/FOR UPDATE/);
        expect(enqueue).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['a dispatch that does not exist', [], {}, 'dispatch_not_found'],
        ['a dispatch that is not delivered', [{ ...delivered, status: 'in_transit' }], {}, 'dispatch_not_delivered'],
        [
            'a dispatchId and a trackingCode of two different dispatches',
            [delivered, { ...delivered, dispatch_id: 43, tracking_code: 'DSP-2026-00043' }],
            { trackingCode: 'DSP-2026-00043' },
            'dispatch_reference_mismatch',
        ],
        ['a trackingCode that is not the one of the dispatchId', [delivered], { trackingCode: 'DSP-2026-00099' }, 'dispatch_reference_mismatch'],
        ['a salesOrderId that is not the order of the dispatch', [delivered], { salesOrderId: 'SO-OTHER' }, 'dispatch_reference_mismatch'],
        [
            'one reference that resolves two stops',
            [delivered, { ...delivered, dispatch_id: 43 }],
            { dispatchId: undefined, trackingCode: 'DSP-2026-00042' },
            'dispatch_reference_ambiguous',
        ],
    ])('rejects %s with %s', async (_label, rows, over, code) => {
        dispatchRows = rows as Record<string, unknown>[];

        const result = await apply(data(over as Partial<DeliveryComplaintOpenedData>));

        expect(result).toEqual({ status: 'rejected', code });
        expect(writes()).toHaveLength(0);
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(enqueue.mock.calls[0]![0]).toMatchObject({
            type: 'dispatch.delivery_complaint.rejected',
            source: 'dispatch',
            data: { correlationMessageId: MESSAGE_ID, crmCaseId: 'CRM-CASE-1', caseVersion: 1, rejectionCode: code },
        });
    });

    it('does not put the reason, the items or any contact data in a rejection', async () => {
        dispatchRows = [];

        await apply(data());

        const payload = JSON.stringify(enqueue.mock.calls[0]![0]);
        expect(payload).not.toContain('DAMAGED_ITEM');
        expect(payload).not.toContain('PKG-1');
        expect(payload).not.toMatch(/phone|email|contact/i);
    });

    it('answers schema_invalid, without touching the database, to a caseVersion that does not fit an INTEGER', async () => {
        const result = await apply(data({ caseVersion: 2_147_483_648 }));

        expect(result).toEqual({ status: 'rejected', code: 'schema_invalid' });
        expect(query).not.toHaveBeenCalled();
        expect(enqueue.mock.calls[0]![0].data).toMatchObject({ rejectionCode: 'schema_invalid', field: '/data/caseVersion' });
    });

    it('searches a dispatchId beyond INTEGER as an id that does not exist', async () => {
        dispatchRows = [];

        const result = await apply(data({ dispatchId: 2_147_483_648 }));

        expect(result).toEqual({ status: 'rejected', code: 'dispatch_not_found' });
        const lookup = query.mock.calls.find(([sql]) => /FROM dispatches/.test(String(sql)))!;
        expect(lookup[1][0]).toBeNull();
    });

    it('a dispatchId beyond INTEGER next to a real trackingCode is a mismatch, not a match', async () => {
        const result = await apply(data({ dispatchId: 2_147_483_648, trackingCode: 'DSP-2026-00042' }));

        expect(result).toEqual({ status: 'rejected', code: 'dispatch_reference_mismatch' });
    });

    it('a persistence error leaves no acknowledgement behind', async () => {
        query.mockImplementation(async (sql: string) => {
            if (/FROM delivery_complaint_cases/.test(sql)) return [];
            if (/FROM dispatches/.test(sql)) return dispatchRows;
            throw new Error('connection lost');
        });

        await expect(apply(data())).rejects.toThrow('connection lost');

        expect(enqueue).not.toHaveBeenCalled();
    });

    it('a database error while looking for the dispatch is not answered as a missing dispatch', async () => {
        query.mockImplementation(async (sql: string) => {
            if (/FROM delivery_complaint_cases/.test(sql)) return [];
            throw new Error('connection lost');
        });

        await expect(apply(data())).rejects.toThrow('connection lost');

        expect(enqueue).not.toHaveBeenCalled();
    });

    it('requires the transaction manager of the inbound message', async () => {
        await expect(service.apply(envelope(data()), data(), {})).rejects.toThrow(/transaction manager/);
    });
});
