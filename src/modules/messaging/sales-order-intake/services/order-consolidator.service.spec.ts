import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryOrderSyncStateAdapter } from '../../sales-order-sync/memory/memory-order-sync-state.adapter.js';
import type { ShipmentBlocks } from '../domain/consolidated-order.types.js';
import type { MarketplaceOrderState } from '../domain/marketplace-order.types.js';
import { MemoryConsolidationRecord } from '../memory/memory-consolidation-record.js';
import { MemoryDispatchGenerator } from '../memory/memory-dispatch-generator.js';
import { MemoryPendingSalesOrderStore } from '../memory/memory-pending-sales-order.store.js';
import { MemoryShipmentBlocksReader } from '../memory/memory-shipment-blocks.reader.js';
import { MarketplaceOrderRepository } from '../repositories/marketplace-order.repository.js';
import { OrderConsolidator } from './order-consolidator.service.js';

const ORDER = 'SO-2026-000123';
const OPTIONS = { manager: undefined };

function marketplaceState(overrides: Partial<MarketplaceOrderState> = {}): MarketplaceOrderState {
    return {
        salesOrderId: ORDER,
        lastRecordVersion: 1,
        baseReceived: true,
        cancelledAt: null,
        cancelledVersion: null,
        blocks: {
            confirmedAt: '2026-10-11T13:58:00Z',
            recipient: { name: 'María López', phone: '+59170000000' },
            deliveryAddress: { line: 'Av. Arce 2345', location: { latitude: -16.5412, longitude: -68.0731 } },
        },
        ...overrides,
    };
}

const SHIPMENT: ShipmentBlocks = {
    warehouseId: 'WH-LPZ-01',
    packages: [{ packageId: 'PKG-1', lengthCm: 40, widthCm: 30, heightCm: 25, grossWeightKg: 6.4 }],
};

describe('OrderConsolidator', () => {
    let syncStates: MemoryOrderSyncStateAdapter;
    let orders: MarketplaceOrderRepository;
    let shipments: MemoryShipmentBlocksReader;
    let generator: MemoryDispatchGenerator;
    let record: MemoryConsolidationRecord;
    let consolidator: OrderConsolidator;

    const saveMarketplace = (state: MarketplaceOrderState) => orders.save(state);
    const saveInventory = async (overrides: { baseReceived?: boolean; cancelledAt?: string | null } = {}) => {
        await syncStates.save({
            salesOrderId: ORDER,
            source: 'inventory',
            lastRecordVersion: 1,
            baseReceived: overrides.baseReceived ?? true,
            cancelledAt: overrides.cancelledAt ?? null,
            cancelledVersion: overrides.cancelledAt ? 2 : null,
        });
    };

    beforeEach(() => {
        syncStates = new MemoryOrderSyncStateAdapter();
        orders = new MarketplaceOrderRepository(syncStates, new MemoryPendingSalesOrderStore());
        shipments = new MemoryShipmentBlocksReader();
        generator = new MemoryDispatchGenerator();
        record = new MemoryConsolidationRecord();
        consolidator = new OrderConsolidator(syncStates, orders, shipments, generator, record);
    });

    it('creates the dispatch and marks the order as consolidated when both sides are there', async () => {
        await saveMarketplace(marketplaceState());
        await saveInventory();
        shipments.set(ORDER, SHIPMENT);

        const result = await consolidator.tryConsolidate(ORDER, OPTIONS);

        expect(result).toMatchObject({ status: 'consolidated', dispatchId: 1 });
        expect(generator.created).toHaveLength(1);
        expect(generator.created[0].order).toMatchObject({
            salesOrderId: ORDER,
            warehouseId: 'WH-LPZ-01',
            confirmedAt: '2026-10-11T13:58:00Z',
        });
        expect(await record.find(ORDER)).toMatchObject({ dispatchId: 1 });
    });

    it('does nothing while only Marketplace arrived, and consolidates when Almacén completes it', async () => {
        await saveMarketplace(marketplaceState());

        const first = await consolidator.tryConsolidate(ORDER, OPTIONS);

        expect(first).toEqual({ status: 'waiting', waitingFor: ['inventory_base'] });
        expect(generator.created).toHaveLength(0);
        expect(await record.find(ORDER)).toBeNull();

        await saveInventory();
        shipments.set(ORDER, SHIPMENT);
        const second = await consolidator.tryConsolidate(ORDER, OPTIONS);

        expect(second.status).toBe('consolidated');
        expect(generator.created).toHaveLength(1);
    });

    it('does nothing while only Almacén arrived, and consolidates when Marketplace completes it', async () => {
        await saveInventory();
        shipments.set(ORDER, SHIPMENT);

        const first = await consolidator.tryConsolidate(ORDER, OPTIONS);

        expect(first).toEqual({ status: 'waiting', waitingFor: ['marketplace_base'] });
        expect(generator.created).toHaveLength(0);

        await saveMarketplace(marketplaceState());
        const second = await consolidator.tryConsolidate(ORDER, OPTIONS);

        expect(second.status).toBe('consolidated');
    });

    it('does not create a second dispatch when it is called again for a consolidated order', async () => {
        await saveMarketplace(marketplaceState());
        await saveInventory();
        shipments.set(ORDER, SHIPMENT);
        await consolidator.tryConsolidate(ORDER, OPTIONS);

        const again = await consolidator.tryConsolidate(ORDER, OPTIONS);

        expect(again).toEqual({ status: 'already_consolidated', dispatchId: 1 });
        expect(generator.created).toHaveLength(1);
    });

    it('does not consolidate a cancelled order', async () => {
        await saveMarketplace(marketplaceState({ cancelledAt: '2026-10-11T15:59:00Z', cancelledVersion: 2 }));
        await saveInventory();
        shipments.set(ORDER, SHIPMENT);

        const result = await consolidator.tryConsolidate(ORDER, OPTIONS);

        expect(result).toEqual({ status: 'cancelled', cancelledBy: ['marketplace'] });
        expect(generator.created).toHaveLength(0);
    });

    it('does not consolidate an order that Almacén cancelled', async () => {
        await saveMarketplace(marketplaceState());
        await saveInventory({ cancelledAt: '2026-10-11T15:59:00Z' });
        shipments.set(ORDER, SHIPMENT);

        const result = await consolidator.tryConsolidate(ORDER, OPTIONS);

        expect(result).toEqual({ status: 'cancelled', cancelledBy: ['inventory'] });
        expect(generator.created).toHaveLength(0);
    });

    it('does not consolidate a shipment that is not ready, and does when it is ready again', async () => {
        await saveMarketplace(marketplaceState());
        await saveInventory();
        shipments.set(ORDER, { ...SHIPMENT, isReady: false });

        const notReady = await consolidator.tryConsolidate(ORDER, OPTIONS);

        expect(notReady).toEqual({ status: 'shipment_not_ready' });
        expect(generator.created).toHaveLength(0);

        shipments.set(ORDER, { ...SHIPMENT, isReady: true });
        const ready = await consolidator.tryConsolidate(ORDER, OPTIONS);

        expect(ready.status).toBe('consolidated');
    });

    it('reports inconsistent data when Almacén has its base but no blocks, and creates nothing', async () => {
        await saveMarketplace(marketplaceState());
        await saveInventory();

        const result = await consolidator.tryConsolidate(ORDER, OPTIONS);

        expect(result.status).toBe('inconsistent');
        expect(generator.created).toHaveLength(0);
        expect(await record.find(ORDER)).toBeNull();
    });

    it('keeps orders apart', async () => {
        await saveMarketplace(marketplaceState());
        await saveInventory();
        shipments.set(ORDER, SHIPMENT);

        const other = await consolidator.tryConsolidate('SO-2026-000999', OPTIONS);

        expect(other).toEqual({ status: 'waiting', waitingFor: ['marketplace_base', 'inventory_base'] });
        expect(generator.created).toHaveLength(0);
    });
});
