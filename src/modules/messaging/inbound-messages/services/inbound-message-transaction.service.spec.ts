import { describe, expect, it, vi } from 'vitest';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import { InboundMessageTransactionService } from './inbound-message-transaction.service.js';

const envelope: MessageEnvelope = {
    messageId: '0199f8c0-0000-7000-8000-000000000001',
    type: 'inventory.shipment.ready', source: 'inventory', schemaVersion: 1,
    occurredAt: '2026-10-12T14:00:00Z', data: { salesOrderId: 'SO-1' },
};

function fixture(existing: 'processed' | 'rejected' | null = null) {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => sql.includes('SELECT status') ? (existing ? [{ status: existing }] : []) : []);
    const manager = { query };
    const dataSource = { transaction: vi.fn(async (work: (value: { query: typeof query }) => Promise<unknown>) => work(manager)) };
    const service = new InboundMessageTransactionService(dataSource as never);
    return { service, query, manager, dataSource };
}

describe('InboundMessageTransactionService', () => {
    it('locks message then order and writes receipt after business changes in one transaction', async () => {
        const { service, query, manager, dataSource } = fixture();
        const order: string[] = [];
        query.mockImplementation(async (sql: string) => {
            order.push(sql.includes('inbound_messages') && sql.includes('INSERT') ? 'receipt' : sql.includes('pg_advisory') ? 'lock' : 'lookup');
            return [];
        });

        const result = await service.process(envelope, 'SO-1', async (options) => {
            expect(options.manager).toBe(manager);
            order.push('business');
        });

        expect(result).toBe('receipt-committed');
        expect(dataSource.transaction).toHaveBeenCalledOnce();
        expect(order).toEqual(['lock', 'lock', 'lookup', 'business', 'receipt']);
        expect(query.mock.calls[0][1]).toEqual([`inbound-message:${envelope.messageId}`]);
        expect(query.mock.calls[1][1]).toEqual(['sales-order:SO-1']);
    });

    it('does not call the business handler or write a receipt for a processed duplicate', async () => {
        const { service, query } = fixture('processed');
        const handle = vi.fn();

        expect(await service.process(envelope, 'SO-1', handle)).toBe('duplicate');
        expect(handle).not.toHaveBeenCalled();
        expect(query).toHaveBeenCalledTimes(3);
    });

    it('retries a corrected rejected message and leaves failure to roll back', async () => {
        const { service, query } = fixture('rejected');
        await expect(service.process(envelope, 'SO-1', async () => { throw new Error('generator failed'); }))
            .rejects.toThrow('generator failed');
        expect(query).toHaveBeenCalledTimes(3);

        expect(await service.process(envelope, 'SO-1', async () => {})).toBe('receipt-committed');
        expect(query.mock.calls.at(-1)?.[0]).toContain("status = 'processed'");
    });
});
