import { describe, expect, it } from 'vitest';
import type { OrderSyncState } from '../ports/order-sync-state.port.js';
import { MemoryOrderSyncStateAdapter } from './memory-order-sync-state.adapter.js';

function state(overrides: Partial<OrderSyncState> = {}): OrderSyncState {
    return {
        salesOrderId: 'SO-1',
        source: 'marketplace',
        lastRecordVersion: 1,
        baseReceived: true,
        cancelledAt: null,
        cancelledVersion: null,
        ...overrides,
    };
}

describe('MemoryOrderSyncStateAdapter', () => {
    it('returns null for an order and origin that were never saved', async () => {
        const adapter = new MemoryOrderSyncStateAdapter();

        await expect(adapter.find('SO-1', 'marketplace')).resolves.toBeNull();
        await expect(adapter.findAllOf('SO-1')).resolves.toEqual([]);
    });

    it('stores one row per order and origin', async () => {
        const adapter = new MemoryOrderSyncStateAdapter();

        await adapter.save(state({ source: 'marketplace', lastRecordVersion: 3 }));
        await adapter.save(state({ source: 'inventory', lastRecordVersion: 7 }));

        expect((await adapter.find('SO-1', 'marketplace'))?.lastRecordVersion).toBe(3);
        expect((await adapter.find('SO-1', 'inventory'))?.lastRecordVersion).toBe(7);
        expect(await adapter.findAllOf('SO-1')).toHaveLength(2);
    });

    it('updates the row of the same order and origin instead of adding another', async () => {
        const adapter = new MemoryOrderSyncStateAdapter();

        await adapter.save(state({ lastRecordVersion: 1 }));
        await adapter.save(state({ lastRecordVersion: 4, cancelledAt: '2026-10-11T15:59:00Z', cancelledVersion: 4 }));

        const rows = await adapter.findAllOf('SO-1');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ lastRecordVersion: 4, cancelledVersion: 4 });
    });

    it('keeps orders apart', async () => {
        const adapter = new MemoryOrderSyncStateAdapter();

        await adapter.save(state({ salesOrderId: 'SO-1' }));
        await adapter.save(state({ salesOrderId: 'SO-2' }));

        expect(await adapter.findAllOf('SO-1')).toHaveLength(1);
        expect(await adapter.findAllOf('SO-2')).toHaveLength(1);
    });

    it('does not leak its stored objects: changing a result does not change the row', async () => {
        const adapter = new MemoryOrderSyncStateAdapter();
        await adapter.save(state({ lastRecordVersion: 2 }));

        const found = await adapter.find('SO-1', 'marketplace');
        found!.lastRecordVersion = 99;

        expect((await adapter.find('SO-1', 'marketplace'))?.lastRecordVersion).toBe(2);
    });
});
