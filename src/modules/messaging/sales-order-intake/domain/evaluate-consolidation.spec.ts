import { describe, expect, it } from 'vitest';
import type { OrderSyncState } from '../../sales-order-sync/ports/order-sync-state.port.js';
import type { ShipmentBlocks } from './consolidated-order.types.js';
import { evaluateConsolidation } from './evaluate-consolidation.js';
import type { MarketplaceOrderState } from './marketplace-order.types.js';

const ORDER = 'SO-2026-000123';

function marketplace(overrides: Partial<MarketplaceOrderState> = {}): MarketplaceOrderState {
    return {
        salesOrderId: ORDER,
        lastRecordVersion: 1,
        baseReceived: true,
        cancelledAt: null,
        cancelledVersion: null,
        blocks: {
            confirmedAt: '2026-10-11T13:58:00Z',
            recipient: { name: 'María López', phone: '+59170000000', email: 'maria@example.com' },
            deliveryAddress: {
                line: 'Av. Arce 2345',
                reference: 'Edificio azul',
                location: { latitude: -16.5412, longitude: -68.0731 },
            },
        },
        ...overrides,
    };
}

function inventory(overrides: Partial<OrderSyncState> = {}): OrderSyncState {
    return {
        salesOrderId: ORDER,
        source: 'inventory',
        lastRecordVersion: 1,
        baseReceived: true,
        cancelledAt: null,
        cancelledVersion: null,
        ...overrides,
    };
}

function shipment(overrides: Partial<ShipmentBlocks> = {}): ShipmentBlocks {
    return {
        warehouseId: 'WH-LPZ-01',
        availableFrom: '2026-10-12T06:00:00Z',
        packages: [{ packageId: 'PKG-1', lengthCm: 40, widthCm: 30, heightCm: 25, grossWeightKg: 6.4 }],
        handlingConditions: ['FRAGILE'],
        evidencePolicy: 'contactless_delivery',
        physicallyPacked: true,
        ...overrides,
    };
}

describe('evaluateConsolidation', () => {
    it('is ready when both bases arrived and joins the two sources', () => {
        const decision = evaluateConsolidation({
            marketplace: marketplace(),
            inventory: inventory(),
            shipment: shipment(),
        });

        expect(decision.status).toBe('ready');
        if (decision.status !== 'ready') return;
        expect(decision.order).toEqual({
            salesOrderId: ORDER,
            confirmedAt: '2026-10-11T13:58:00Z',
            recipient: { name: 'María López', phone: '+59170000000', email: 'maria@example.com' },
            deliveryAddress: {
                line: 'Av. Arce 2345',
                reference: 'Edificio azul',
                location: { latitude: -16.5412, longitude: -68.0731 },
            },
            priority: 'normal',
            warehouseId: 'WH-LPZ-01',
            availableFrom: '2026-10-12T06:00:00Z',
            packages: [{ packageId: 'PKG-1', lengthCm: 40, widthCm: 30, heightCm: 25, grossWeightKg: 6.4 }],
            handlingConditions: ['FRAGILE'],
            evidencePolicy: 'contactless_delivery',
            physicallyPacked: true,
        });
    });

    it('applies the contract defaults for what the sources leave out', () => {
        const decision = evaluateConsolidation({
            marketplace: marketplace(),
            inventory: inventory(),
            shipment: {
                warehouseId: 'WH-LPZ-01',
                packages: [{ packageId: 'PKG-1', lengthCm: 10, widthCm: 10, heightCm: 10, grossWeightKg: 1 }],
            },
        });

        expect(decision.status).toBe('ready');
        if (decision.status !== 'ready') return;
        expect(decision.order.priority).toBe('normal');
        expect(decision.order.evidencePolicy).toBe('hand_delivery_standard');
        expect(decision.order.physicallyPacked).toBe(false);
        expect(decision.order.handlingConditions).toEqual([]);
        expect(decision.order.availableFrom).toBeUndefined();
        expect(decision.order.preferences).toBeUndefined();
    });

    it('keeps the optional Marketplace blocks and the urgent priority', () => {
        const state = marketplace();
        state.blocks.preferences = { contactless: true, notes: 'Portería' };
        state.blocks.deliveryDeadline = '2026-10-20T20:00:00Z';
        state.blocks.priority = 'urgent';

        const decision = evaluateConsolidation({ marketplace: state, inventory: inventory(), shipment: shipment() });

        expect(decision.status).toBe('ready');
        if (decision.status !== 'ready') return;
        expect(decision.order.preferences).toEqual({ contactless: true, notes: 'Portería' });
        expect(decision.order.deliveryDeadline).toBe('2026-10-20T20:00:00Z');
        expect(decision.order.priority).toBe('urgent');
    });

    it('does not require coordinates: the order is ready and the dispatch goes to address_review', () => {
        const state = marketplace();
        state.blocks.deliveryAddress = { line: 'Calle 21 de Calacoto' };

        const decision = evaluateConsolidation({ marketplace: state, inventory: inventory(), shipment: shipment() });

        expect(decision.status).toBe('ready');
    });

    it.each([
        ['no Marketplace data at all', null, inventory(), shipment(), ['marketplace_base']],
        ['Marketplace without its base', marketplace({ baseReceived: false }), inventory(), shipment(), ['marketplace_base']],
        ['no Almacén data at all', marketplace(), null, null, ['inventory_base']],
        ['Almacén without its base', marketplace(), inventory({ baseReceived: false }), null, ['inventory_base']],
        ['neither source', null, null, null, ['marketplace_base', 'inventory_base']],
    ])('waits with %s', (_name, mp, inv, ship, expected) => {
        const decision = evaluateConsolidation({ marketplace: mp, inventory: inv, shipment: ship });

        expect(decision).toEqual({ status: 'waiting', waitingFor: expected });
    });

    it('waits when only updates arrived and no base did, in any order', () => {
        const decision = evaluateConsolidation({
            marketplace: marketplace({ baseReceived: false, blocks: { recipient: { name: 'A', phone: '+59170000000' } } }),
            inventory: inventory({ baseReceived: false }),
            shipment: null,
        });

        expect(decision).toEqual({ status: 'waiting', waitingFor: ['marketplace_base', 'inventory_base'] });
    });

    it.each([
        ['Marketplace', marketplace({ cancelledAt: '2026-10-11T15:59:00Z', cancelledVersion: 3 }), inventory(), ['marketplace']],
        ['Almacén', marketplace(), inventory({ cancelledAt: '2026-10-11T15:59:00Z', cancelledVersion: 2 }), ['inventory']],
        [
            'both',
            marketplace({ cancelledAt: '2026-10-11T15:59:00Z', cancelledVersion: 3 }),
            inventory({ cancelledAt: '2026-10-11T16:00:00Z', cancelledVersion: 2 }),
            ['marketplace', 'inventory'],
        ],
    ])('never consolidates an order cancelled by %s', (_name, mp, inv, expected) => {
        const decision = evaluateConsolidation({ marketplace: mp, inventory: inv, shipment: shipment() });

        expect(decision).toEqual({ status: 'cancelled', cancelledBy: expected });
    });

    it('reports a cancellation even if a base is still missing', () => {
        const decision = evaluateConsolidation({
            marketplace: marketplace({ baseReceived: false, cancelledAt: '2026-10-11T15:59:00Z', cancelledVersion: 2 }),
            inventory: null,
            shipment: null,
        });

        expect(decision).toEqual({ status: 'cancelled', cancelledBy: ['marketplace'] });
    });

    it('does not consolidate a shipment that Almacén marked as not ready', () => {
        const decision = evaluateConsolidation({
            marketplace: marketplace(),
            inventory: inventory(),
            shipment: shipment({ isReady: false }),
        });

        expect(decision).toEqual({ status: 'shipment_not_ready' });
    });

    it('treats isReady true and an absent isReady as ready', () => {
        const withTrue = evaluateConsolidation({
            marketplace: marketplace(),
            inventory: inventory(),
            shipment: shipment({ isReady: true }),
        });
        const withoutIt = evaluateConsolidation({
            marketplace: marketplace(),
            inventory: inventory(),
            shipment: shipment(),
        });

        expect(withTrue.status).toBe('ready');
        expect(withoutIt.status).toBe('ready');
    });

    it('flags inconsistent data instead of creating an incomplete dispatch', () => {
        const noShipment = evaluateConsolidation({ marketplace: marketplace(), inventory: inventory(), shipment: null });
        const noPackages = evaluateConsolidation({
            marketplace: marketplace(),
            inventory: inventory(),
            shipment: shipment({ packages: [] }),
        });
        const noWarehouse = evaluateConsolidation({
            marketplace: marketplace(),
            inventory: inventory(),
            shipment: shipment({ warehouseId: undefined }),
        });
        const noRecipient = evaluateConsolidation({
            marketplace: marketplace({ blocks: { confirmedAt: '2026-10-11T13:58:00Z' } }),
            inventory: inventory(),
            shipment: shipment(),
        });

        for (const decision of [noShipment, noPackages, noWarehouse, noRecipient]) {
            expect(decision.status).toBe('inconsistent');
        }
    });

    it('returns a copy: changing the order does not change the state it came from', () => {
        const state = marketplace();
        const blocks = shipment();

        const decision = evaluateConsolidation({ marketplace: state, inventory: inventory(), shipment: blocks });
        if (decision.status !== 'ready') throw new Error('expected ready');
        decision.order.recipient.name = 'Changed';
        decision.order.packages[0].grossWeightKg = 999;

        expect(state.blocks.recipient?.name).toBe('María López');
        expect(blocks.packages?.[0].grossWeightKg).toBe(6.4);
    });
});
