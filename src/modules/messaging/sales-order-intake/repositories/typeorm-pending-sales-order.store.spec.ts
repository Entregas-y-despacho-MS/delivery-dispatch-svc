import { describe, expect, it, vi } from 'vitest';
import { PendingSalesOrder } from '../entities/pending-sales-order.entity.js';
import { TypeOrmPendingSalesOrderStore } from './typeorm-pending-sales-order.store.js';

const ORDER = 'SO-2026-000123';

describe('TypeOrmPendingSalesOrderStore', () => {
    const build = (row: Partial<PendingSalesOrder> | null = null) => {
        const orderRepo = { findOneBy: vi.fn().mockResolvedValue(row) };
        const manager = { getRepository: vi.fn().mockReturnValue(orderRepo), query: vi.fn().mockResolvedValue([]) };
        const dataSource = { manager };
        return { orderRepo, manager, store: new TypeOrmPendingSalesOrderStore(dataSource as never) };
    };

    it('find returns null when there is no row', async () => {
        const { store, orderRepo, manager } = build(null);

        await expect(store.find(ORDER)).resolves.toBeNull();
        expect(manager.getRepository).toHaveBeenCalledWith(PendingSalesOrder);
        expect(orderRepo.findOneBy).toHaveBeenCalledWith({ salesOrderId: ORDER });
    });

    it('find maps the row to a record', async () => {
        const { store } = build({
            salesOrderId: ORDER,
            recordVersion: 3,
            payload: { confirmedAt: '2026-10-11T13:58:00Z' },
        });

        await expect(store.find(ORDER)).resolves.toEqual({
            salesOrderId: ORDER,
            recordVersion: 3,
            blocks: { confirmedAt: '2026-10-11T13:58:00Z' },
        });
    });

    it('find uses the manager of the transaction when it is given', async () => {
        const { store, manager } = build(null);
        const txOrderRepo = { findOneBy: vi.fn().mockResolvedValue(null) };
        const txManager = { getRepository: vi.fn().mockReturnValue(txOrderRepo) };

        await store.find(ORDER, { manager: txManager as never });

        expect(txManager.getRepository).toHaveBeenCalledWith(PendingSalesOrder);
        expect(manager.getRepository).not.toHaveBeenCalled();
    });

    it('save is one upsert that never lowers the stored version', async () => {
        const { store, manager } = build();

        await store.save({
            salesOrderId: ORDER,
            recordVersion: 2,
            blocks: { recipient: { name: 'María López', phone: '+59170000000' } },
        });

        const [sql, params] = manager.query.mock.calls[0];
        expect(sql).toContain('INSERT INTO pending_sales_orders');
        expect(sql).toContain('ON CONFLICT (sales_order_id) DO UPDATE');
        expect(sql).toContain('GREATEST(pending_sales_orders.record_version, EXCLUDED.record_version)');
        expect(params).toEqual([
            ORDER,
            2,
            JSON.stringify({ recipient: { name: 'María López', phone: '+59170000000' } }),
        ]);
    });

    it('save runs inside the transaction manager when it is given', async () => {
        const { store, manager } = build();
        const txManager = { query: vi.fn().mockResolvedValue([]) };

        await store.save({ salesOrderId: ORDER, recordVersion: 1, blocks: {} }, { manager: txManager as never });

        expect(txManager.query).toHaveBeenCalledTimes(1);
        expect(manager.query).not.toHaveBeenCalled();
    });
});
