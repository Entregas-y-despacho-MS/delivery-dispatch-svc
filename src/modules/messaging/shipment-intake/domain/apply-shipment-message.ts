import type { ShipmentBlocks, ShipmentMessage, ShipmentState } from './shipment-message.types.js';

export type ShipmentApplyOutcome = 'applied' | 'base_completed_late' | 'ignored_stale' | 'ignored_cancelled';

export interface ShipmentApplyResult {
    outcome: ShipmentApplyOutcome;
    state: ShipmentState;
}

export function emptyShipmentState(salesOrderId: string): ShipmentState {
    return {
        salesOrderId,
        lastRecordVersion: 0,
        baseReceived: false,
        cancelledAt: null,
        cancelledVersion: null,
        blocks: {},
    };
}

/**
 * Merge one schema-valid Inventory message. Versions belong only to the Inventory origin.
 * A late `ready` supplies a missing base without rolling back newer `updated` blocks.
 */
export function applyShipmentMessage(state: ShipmentState | null, message: ShipmentMessage): ShipmentApplyResult {
    const current = state ?? emptyShipmentState(message.data.salesOrderId);
    if (current.cancelledAt !== null) return { outcome: 'ignored_cancelled', state: current };

    const version = message.data.recordVersion;
    const isNewer = version > current.lastRecordVersion;

    if (message.kind === 'cancelled') {
        if (!isNewer) return { outcome: 'ignored_stale', state: current };
        return {
            outcome: 'applied',
            state: {
                ...current,
                lastRecordVersion: version,
                cancelledAt: message.data.cancelledAt,
                cancelledVersion: version,
            },
        };
    }

    const incoming = blocksOf(message);
    if (isNewer) {
        return {
            outcome: 'applied',
            state: {
                ...current,
                lastRecordVersion: version,
                baseReceived: current.baseReceived || message.kind === 'ready',
                blocks: { ...current.blocks, ...incoming },
            },
        };
    }

    if (message.kind === 'ready' && !current.baseReceived) {
        return {
            outcome: 'base_completed_late',
            state: {
                ...current,
                baseReceived: true,
                blocks: { ...incoming, ...current.blocks },
            },
        };
    }

    return { outcome: 'ignored_stale', state: current };
}

function blocksOf(message: Exclude<ShipmentMessage, { kind: 'cancelled' }>): ShipmentBlocks {
    const { data } = message;
    const blocks: ShipmentBlocks = {};

    if (data.warehouseId !== undefined) blocks.warehouseId = data.warehouseId;
    if (data.availableFrom !== undefined) blocks.availableFrom = data.availableFrom;
    if (data.packages !== undefined) blocks.packages = structuredClone(data.packages);
    if (data.handlingConditions !== undefined) blocks.handlingConditions = [...data.handlingConditions];
    if (data.evidencePolicy !== undefined) blocks.evidencePolicy = data.evidencePolicy;
    if (data.physicallyPacked !== undefined) blocks.physicallyPacked = data.physicallyPacked;

    if (message.kind === 'ready') {
        blocks.isReady = true;
        blocks.evidencePolicy ??= 'hand_delivery_standard';
        blocks.physicallyPacked ??= false;
    } else {
        blocks.isReady = message.data.isReady;
    }

    return blocks;
}
