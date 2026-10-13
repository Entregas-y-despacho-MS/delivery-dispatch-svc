import { describe, expect, it, vi } from 'vitest';
import { TypeOrmConsolidationRecord } from './typeorm-consolidation-record.js';

const ORDER = 'SO-2026-000123';

describe('TypeOrmConsolidationRecord', () => {
    const build = (rows: unknown[] = []) => {
        const manager = { query: vi.fn().mockResolvedValue(rows) };
        const dataSource = { manager };
        return { manager, record: new TypeOrmConsolidationRecord(dataSource as never) };
    };

    it('find returns null when the order was not consolidated', async () => {
        const { record, manager } = build([]);

        await expect(record.find(ORDER)).resolves.toBeNull();
        const [sql, params] = manager.query.mock.calls[0];
        expect(sql).toContain('consolidated_at IS NOT NULL');
        expect(params).toEqual([ORDER]);
    });

    it('find returns the dispatch and the moment of the consolidation', async () => {
        const { record } = build([{ dispatch_id: 17, consolidated_at: '2026-10-12T14:00:00.000Z' }]);

        const mark = await record.find(ORDER);

        expect(mark).toEqual({ dispatchId: 17, consolidatedAt: new Date('2026-10-12T14:00:00.000Z') });
    });

    it('mark updates the rows of both sources with the same dispatch', async () => {
        const { record, manager } = build();
        const consolidatedAt = new Date('2026-10-12T14:00:00.000Z');

        await record.mark(ORDER, { dispatchId: 17, consolidatedAt });

        expect(manager.query).toHaveBeenCalledTimes(2);
        const [first, second] = manager.query.mock.calls;
        expect(first[0]).toContain('UPDATE pending_sales_orders');
        expect(second[0]).toContain('UPDATE pending_shipments');
        expect(first[1]).toEqual([ORDER, consolidatedAt, 17]);
        expect(second[1]).toEqual([ORDER, consolidatedAt, 17]);
    });

    it('runs inside the transaction manager when it is given', async () => {
        const { record, manager } = build();
        const tx = { query: vi.fn().mockResolvedValue([]) };

        await record.mark(ORDER, { dispatchId: 1, consolidatedAt: new Date() }, { manager: tx as never });
        await record.find(ORDER, { manager: tx as never });

        expect(tx.query).toHaveBeenCalledTimes(3);
        expect(manager.query).not.toHaveBeenCalled();
    });
});
