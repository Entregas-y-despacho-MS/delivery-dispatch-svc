import type { OrderSyncSource, OrderSyncState } from '../../sales-order-sync/ports/order-sync-state.port.js';
import {
    DEFAULT_EVIDENCE_POLICY,
    DEFAULT_PRIORITY,
    type ConsolidatedOrder,
    type ShipmentBlocks,
} from './consolidated-order.types.js';
import type { MarketplaceOrderState } from './marketplace-order.types.js';

/** Which base is still missing. */
export type WaitingFor = 'marketplace_base' | 'inventory_base';

export type ConsolidationDecision =
    /** Both bases arrived, nothing cancelled and the shipment is ready: the dispatch can be created. */
    | { status: 'ready'; order: ConsolidatedOrder }
    /** At least one base is missing; nothing is created and nothing is shown in the tray. */
    | { status: 'waiting'; waitingFor: WaitingFor[] }
    /** Cancelled by one or both sources. Terminal. */
    | { status: 'cancelled'; cancelledBy: OrderSyncSource[] }
    /** Almacén reported `isReady: false`: the order waits until it is ready again. */
    | { status: 'shipment_not_ready' }
    /** The flags say a base arrived but its blocks are not there. Needs a person; never retried blindly. */
    | { status: 'inconsistent'; detail: string };

export interface ConsolidationInput {
    /** Marketplace state of the order, or `null` if nothing from Marketplace was stored. */
    marketplace: MarketplaceOrderState | null;
    /** Sync state of Almacén, or `null` if there is no row. */
    inventory: OrderSyncState | null;
    /** Merged blocks of Almacén; only needed once its base arrived. */
    shipment: ShipmentBlocks | null;
}

/**
 * Decides whether a sales order can become a dispatch. Pure: it reads nothing and writes nothing.
 *
 * It waits for the base of both sources (`confirmed` and `ready`) in any order of arrival, never
 * consolidates a cancelled order (terminal for each source) and never consolidates a shipment that
 * Almacén marked as not ready. A `ready` of a higher version sets `isReady` again.
 */
export function evaluateConsolidation(input: ConsolidationInput): ConsolidationDecision {
    const { marketplace, inventory, shipment } = input;

    const cancelledBy: OrderSyncSource[] = [];
    if (marketplace?.cancelledAt) cancelledBy.push('marketplace');
    if (inventory?.cancelledAt) cancelledBy.push('inventory');
    if (cancelledBy.length > 0) return { status: 'cancelled', cancelledBy };

    const waitingFor: WaitingFor[] = [];
    if (!marketplace?.baseReceived) waitingFor.push('marketplace_base');
    if (!inventory?.baseReceived) waitingFor.push('inventory_base');
    if (waitingFor.length > 0) return { status: 'waiting', waitingFor };

    // Both bases arrived, so both sides must have their blocks.
    if (shipment === null) return { status: 'inconsistent', detail: 'inventory base received without shipment blocks' };
    if (shipment.isReady === false) return { status: 'shipment_not_ready' };

    const blocks = marketplace!.blocks;
    if (!blocks.confirmedAt || !blocks.recipient || !blocks.deliveryAddress) {
        return { status: 'inconsistent', detail: 'marketplace base received without confirmedAt, recipient or deliveryAddress' };
    }
    if (!shipment.warehouseId || !shipment.packages || shipment.packages.length === 0) {
        return { status: 'inconsistent', detail: 'inventory base received without warehouseId or packages' };
    }

    return {
        status: 'ready',
        order: {
            salesOrderId: marketplace!.salesOrderId,
            confirmedAt: blocks.confirmedAt,
            recipient: structuredClone(blocks.recipient),
            deliveryAddress: structuredClone(blocks.deliveryAddress),
            ...(blocks.preferences !== undefined && { preferences: structuredClone(blocks.preferences) }),
            ...(blocks.deliveryDeadline !== undefined && { deliveryDeadline: blocks.deliveryDeadline }),
            priority: blocks.priority ?? DEFAULT_PRIORITY,
            warehouseId: shipment.warehouseId,
            ...(shipment.availableFrom !== undefined && { availableFrom: shipment.availableFrom }),
            packages: structuredClone(shipment.packages),
            handlingConditions: [...(shipment.handlingConditions ?? [])],
            evidencePolicy: shipment.evidencePolicy ?? DEFAULT_EVIDENCE_POLICY,
            physicallyPacked: shipment.physicallyPacked ?? false,
        },
    };
}
