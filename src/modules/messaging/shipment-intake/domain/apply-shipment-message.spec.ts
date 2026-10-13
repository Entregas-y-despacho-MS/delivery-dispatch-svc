import { describe, expect, it } from 'vitest';
import { applyShipmentMessage } from './apply-shipment-message.js';
import type { ShipmentCancelledData, ShipmentReadyData, ShipmentUpdatedData } from './shipment-message.types.js';

const salesOrderId = 'SO-2026-000123';
const packages = [{ packageId: 'PK-1', lengthCm: 10, widthCm: 20, heightCm: 30, grossWeightKg: 2.5 }];

function ready(overrides: Partial<ShipmentReadyData> = {}): ShipmentReadyData {
    return {
        salesOrderId, recordVersion: 1, updatedAt: '2026-10-12T14:00:00Z',
        warehouseId: 'WH-LPZ-01', packages, ...overrides,
    };
}

function updated(overrides: Partial<ShipmentUpdatedData> = {}): ShipmentUpdatedData {
    return {
        salesOrderId, recordVersion: 2, updatedAt: '2026-10-12T15:00:00Z',
        isReady: false, ...overrides,
    };
}

function cancelled(overrides: Partial<ShipmentCancelledData> = {}): ShipmentCancelledData {
    return {
        salesOrderId, recordVersion: 3, updatedAt: '2026-10-12T16:00:00Z',
        cancelledAt: '2026-10-12T15:59:00Z', ...overrides,
    };
}

describe('applyShipmentMessage', () => {
    it('receives a ready base with contract defaults and independent package data', () => {
        const data = ready();
        const result = applyShipmentMessage(null, { kind: 'ready', data });

        expect(result.outcome).toBe('applied');
        expect(result.state).toEqual({
            salesOrderId, lastRecordVersion: 1, baseReceived: true,
            cancelledAt: null, cancelledVersion: null,
            blocks: {
                warehouseId: 'WH-LPZ-01', packages, isReady: true,
                evidencePolicy: 'hand_delivery_standard', physicallyPacked: false,
            },
        });
        data.packages[0].grossWeightKg = 99;
        expect(result.state.blocks.packages?.[0].grossWeightKg).toBe(2.5);
    });

    it('keeps an updated in waiting state until a ready supplies the missing base', () => {
        const first = applyShipmentMessage(null, {
            kind: 'updated', data: updated({
                recordVersion: 2, isReady: false, packages: [{ ...packages[0], grossWeightKg: 3 }],
            }),
        });
        expect(first.state.baseReceived).toBe(false);
        expect(first.state.blocks.isReady).toBe(false);

        const completed = applyShipmentMessage(first.state, { kind: 'ready', data: ready() });
        expect(completed.outcome).toBe('base_completed_late');
        expect(completed.state.baseReceived).toBe(true);
        expect(completed.state.lastRecordVersion).toBe(2);
        expect(completed.state.blocks.warehouseId).toBe('WH-LPZ-01');
        expect(completed.state.blocks.packages?.[0].grossWeightKg).toBe(3);
        expect(completed.state.blocks.isReady).toBe(false);
    });

    it('a newer ready restores readiness and an updated replaces complete blocks', () => {
        const first = applyShipmentMessage(null, { kind: 'ready', data: ready() });
        const held = applyShipmentMessage(first.state, { kind: 'updated', data: updated() });
        const restored = applyShipmentMessage(held.state, { kind: 'ready', data: ready({ recordVersion: 3 }) });

        expect(held.state.blocks.isReady).toBe(false);
        expect(restored.state.blocks.isReady).toBe(true);
        expect(restored.state.lastRecordVersion).toBe(3);
    });

    it('ignores older and equal versions after the base arrived', () => {
        const state = applyShipmentMessage(null, { kind: 'ready', data: ready({ recordVersion: 3 }) }).state;

        for (const version of [2, 3]) {
            const result = applyShipmentMessage(state, { kind: 'updated', data: updated({ recordVersion: version }) });
            expect(result.outcome).toBe('ignored_stale');
            expect(result.state).toBe(state);
        }
    });

    it('a cancellation in waiting state blocks a late ready', () => {
        const stopped = applyShipmentMessage(null, { kind: 'cancelled', data: cancelled() });
        expect(stopped.state.cancelledVersion).toBe(3);
        expect(stopped.state.baseReceived).toBe(false);

        const late = applyShipmentMessage(stopped.state, { kind: 'ready', data: ready() });
        expect(late.outcome).toBe('ignored_cancelled');
        expect(late.state).toBe(stopped.state);
    });

    it('a stale cancellation does not override newer inventory data', () => {
        const state = applyShipmentMessage(null, { kind: 'ready', data: ready({ recordVersion: 4 }) }).state;
        const result = applyShipmentMessage(state, { kind: 'cancelled', data: cancelled() });

        expect(result.outcome).toBe('ignored_stale');
        expect(result.state.cancelledAt).toBeNull();
    });
});
