/**
 * Marketplace side of the sales-order intake (ST-72.2). Plain types of the sales-order blocks and of
 * the per-order state kept for the `marketplace` source. They mirror the `data` of the schemas in
 * `contracts/messages/schemas/marketplace.sales_order.*.schema.json`; nothing here adds a field.
 */

export type OrderPriority = 'urgent' | 'normal';

/** Recipient block. `email` is optional (D-19: an order without email is still valid). */
export interface OrderRecipient {
    name: string;
    phone: string;
    email?: string;
}

/** Delivery address block. Without `location` the dispatch is created in `address_review`. */
export interface OrderDeliveryAddress {
    line: string;
    reference?: string;
    location?: { latitude: number; longitude: number };
}

export interface OrderPreferences {
    preferredWindowStart?: string;
    preferredWindowEnd?: string;
    contactless?: boolean;
    notes?: string;
}

/**
 * Blocks of the sales order that Marketplace sends. Each one replaces the previous value as a
 * whole; a block that is absent keeps what was stored.
 */
export interface MarketplaceOrderBlocks {
    /** Commercial confirmation (D0). Only `confirmed` carries it. */
    confirmedAt?: string;
    recipient?: OrderRecipient;
    deliveryAddress?: OrderDeliveryAddress;
    preferences?: OrderPreferences;
    deliveryDeadline?: string;
    priority?: OrderPriority;
}

/**
 * State of one sales order for the `marketplace` source. It outlives the dispatch: the version and
 * the cancellation mark must survive after the order is consolidated.
 */
export interface MarketplaceOrderState {
    salesOrderId: string;
    /** Last `recordVersion` applied. `0` means nothing was received yet (the minimum real one is 1). */
    lastRecordVersion: number;
    /** `true` once `confirmed` was applied, in any order of arrival. */
    baseReceived: boolean;
    /** Set by a cancellation. It is terminal for this source: nothing reactivates the order. */
    cancelledAt: string | null;
    cancelledVersion: number | null;
    blocks: MarketplaceOrderBlocks;
}

/** `data` of `marketplace.sales_order.confirmed`. */
export interface ConfirmedOrderData {
    salesOrderId: string;
    recordVersion: number;
    updatedAt: string;
    confirmedAt: string;
    recipient: OrderRecipient;
    deliveryAddress: OrderDeliveryAddress;
    preferences?: OrderPreferences;
    deliveryDeadline?: string;
    priority?: OrderPriority;
}

/** `data` of `marketplace.sales_order.updated`. At least one block comes besides the identification. */
export interface UpdatedOrderData {
    salesOrderId: string;
    recordVersion: number;
    updatedAt: string;
    recipient?: OrderRecipient;
    deliveryAddress?: OrderDeliveryAddress;
    preferences?: OrderPreferences;
    deliveryDeadline?: string;
    priority?: OrderPriority;
}

/** `data` of `marketplace.sales_order.cancelled`. */
export interface CancelledOrderData {
    salesOrderId: string;
    recordVersion: number;
    updatedAt: string;
    cancelledAt: string;
    reason?: string;
}

/** A schema-valid Marketplace message, tagged by the topic it arrived on. */
export type MarketplaceOrderMessage =
    | { kind: 'confirmed'; data: ConfirmedOrderData }
    | { kind: 'updated'; data: UpdatedOrderData }
    | { kind: 'cancelled'; data: CancelledOrderData };
