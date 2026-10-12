import type { OrderDeliveryAddress, OrderPreferences, OrderPriority, OrderRecipient } from './marketplace-order.types.js';

/**
 * The join of the two sources of a sales order (ST-72.2). The Almacén side mirrors the `data` of
 * `inventory.shipment.ready` / `.updated` in `contracts/messages/schemas/`; nothing here adds a field.
 */

/** Same values as the `CHECK` of `dispatches.evidence_policy`. */
export type EvidencePolicy = 'hand_delivery_standard' | 'contactless_delivery' | 'high_value_control';

/** Used when Almacén does not send `evidencePolicy`. */
export const DEFAULT_EVIDENCE_POLICY: EvidencePolicy = 'hand_delivery_standard';

/** Used when Marketplace does not send `priority`. */
export const DEFAULT_PRIORITY: OrderPriority = 'normal';

/** One package with its real measures (cm) and gross weight (kg). */
export interface ShipmentPackage {
    packageId: string;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    grossWeightKg: number;
}

/**
 * Blocks of the shipment that Almacén sends, merged by block (the payload of `pending_shipments`).
 * `isReady: false` means the order stopped being ready to pick up; absent counts as ready.
 */
export interface ShipmentBlocks {
    warehouseId?: string;
    availableFrom?: string;
    packages?: ShipmentPackage[];
    handlingConditions?: string[];
    evidencePolicy?: EvidencePolicy;
    physicallyPacked?: boolean;
    isReady?: boolean;
}

/**
 * Everything `ST-49.1` needs to create the dispatch of a sales order, with the contract defaults
 * already applied. It exists only when both bases arrived, nothing was cancelled and the shipment is
 * still ready.
 */
export interface ConsolidatedOrder {
    salesOrderId: string;

    // Marketplace
    /** Commercial confirmation (D0); the delivery term runs from here. */
    confirmedAt: string;
    recipient: OrderRecipient;
    /** Without `location` the dispatch is created in `address_review`. */
    deliveryAddress: OrderDeliveryAddress;
    preferences?: OrderPreferences;
    deliveryDeadline?: string;
    priority: OrderPriority;

    // Almacén
    /** Code of the warehouse (`warehouses.code`), not its numeric id. */
    warehouseId: string;
    availableFrom?: string;
    packages: ShipmentPackage[];
    handlingConditions: string[];
    evidencePolicy: EvidencePolicy;
    physicallyPacked: boolean;
}
