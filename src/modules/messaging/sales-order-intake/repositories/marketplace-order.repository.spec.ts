import { describe, expect, it } from 'vitest';
import { MemoryOrderSyncStateAdapter } from '../../sales-order-sync/memory/memory-order-sync-state.adapter.js';
import type { MarketplaceOrderState } from '../domain/marketplace-order.types.js';
import { MemoryPendingSalesOrderStore } from '../memory/memory-pending-sales-order.store.js';
import { MarketplaceOrderRepository } from './marketplace-order.repository.js';

const ORDER = 'SO-2026-000123';

function build() {
    const syncStates = new MemoryOrderSyncStateAdapter();
    const pending = new MemoryPendingSalesOrderStore();
    return { syncStates, pending, repository: new MarketplaceOrderRepository(syncStates, pending) };
}

function state(overrides: Partial<MarketplaceOrderState> = {}): MarketplaceOrderState {
    return {
        salesOrderId: ORDER,
        lastRecordVersion: 1,
        baseReceived: true,
        cancelledAt: null,
        cancelledVersion: null,
        blocks: {
            confirmedAt: '2026-10-11T13:58:00Z',
            recipient: { name: 'María López', phone: '+59170000000' },
            deliveryAddress: { line: 'Av. Arce 2345, Sopocachi' },
        },
        ...overrides,
    };
}

describe('MarketplaceOrderRepository', () => {
    it('returns null when nothing from Marketplace was stored', async () => {
        const { repository } = build();

        await expect(repository.find(ORDER)).resolves.toBeNull();
    });

    it('gives back what it saved', async () => {
        const { repository } = build();

        await repository.save(state({ lastRecordVersion: 3 }));

        await expect(repository.find(ORDER)).resolves.toEqual(state({ lastRecordVersion: 3 }));
    });

    it('stores the version and the cancellation in the sync state and the blocks apart', async () => {
        const { repository, syncStates, pending } = build();

        await repository.save(
            state({ lastRecordVersion: 4, cancelledAt: '2026-10-11T15:59:00Z', cancelledVersion: 4 }),
        );

        expect(await syncStates.find(ORDER, 'marketplace')).toEqual({
            salesOrderId: ORDER,
            source: 'marketplace',
            lastRecordVersion: 4,
            baseReceived: true,
            cancelledAt: '2026-10-11T15:59:00Z',
            cancelledVersion: 4,
        });
        expect((await pending.find(ORDER))?.blocks.confirmedAt).toBe('2026-10-11T13:58:00Z');
    });

    it('writes only the marketplace row and leaves the inventory one alone', async () => {
        const { repository, syncStates } = build();
        await syncStates.save({
            salesOrderId: ORDER,
            source: 'inventory',
            lastRecordVersion: 9,
            baseReceived: true,
            cancelledAt: null,
            cancelledVersion: null,
        });

        await repository.save(state());

        expect((await syncStates.find(ORDER, 'inventory'))?.lastRecordVersion).toBe(9);
        expect(await syncStates.findAllOf(ORDER)).toHaveLength(2);
    });

    it('keeps the cancellation of an order that never had a base', async () => {
        const { repository } = build();

        await repository.save(
            state({
                lastRecordVersion: 2,
                baseReceived: false,
                cancelledAt: '2026-10-11T15:59:00Z',
                cancelledVersion: 2,
                blocks: {},
            }),
        );

        const found = await repository.find(ORDER);
        expect(found?.baseReceived).toBe(false);
        expect(found?.cancelledVersion).toBe(2);
        expect(found?.blocks).toEqual({});
    });

    it('reads a sync row without blocks as an empty set of blocks', async () => {
        const { repository, syncStates } = build();
        // The recovery job (ST-50.5) creates the row of an origin that never sent anything.
        await syncStates.save({
            salesOrderId: ORDER,
            source: 'marketplace',
            lastRecordVersion: 0,
            baseReceived: false,
            cancelledAt: null,
            cancelledVersion: null,
        });

        const found = await repository.find(ORDER);

        expect(found).toEqual({
            salesOrderId: ORDER,
            lastRecordVersion: 0,
            baseReceived: false,
            cancelledAt: null,
            cancelledVersion: null,
            blocks: {},
        });
    });

    it('rebuilds the state of a row that predates the sync state: the base is known from confirmedAt', async () => {
        const { repository, pending } = build();
        await pending.save({
            salesOrderId: ORDER,
            recordVersion: 5,
            blocks: { confirmedAt: '2026-10-11T13:58:00Z', recipient: { name: 'María López', phone: '+59170000000' } },
        });

        const found = await repository.find(ORDER);

        expect(found?.lastRecordVersion).toBe(5);
        expect(found?.baseReceived).toBe(true);
        expect(found?.cancelledAt).toBeNull();
    });

    it('does not take a row that predates the sync state for a base when confirmedAt is missing', async () => {
        const { repository, pending } = build();
        await pending.save({
            salesOrderId: ORDER,
            recordVersion: 2,
            blocks: { recipient: { name: 'María López', phone: '+59170000000' } },
        });

        const found = await repository.find(ORDER);

        expect(found?.baseReceived).toBe(false);
    });

    it('never lowers the stored version of the blocks, even if saved with a lower one', async () => {
        const { repository, pending } = build();
        await repository.save(state({ lastRecordVersion: 5 }));

        await repository.save(state({ lastRecordVersion: 3 }));

        expect((await pending.find(ORDER))?.recordVersion).toBe(5);
    });
});
