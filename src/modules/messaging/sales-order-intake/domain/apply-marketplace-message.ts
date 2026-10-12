import type {
    MarketplaceOrderBlocks,
    MarketplaceOrderMessage,
    MarketplaceOrderState,
} from './marketplace-order.types.js';

/**
 * What happened to a message:
 * - `applied`: it was newer than the stored version and changed the state.
 * - `base_completed_late`: a `confirmed` that arrived after a newer `updated`; it only filled the
 *   blocks that the `updated` did not bring and did not lower the stored version.
 * - `ignored_stale`: version lower than or equal to the stored one (and no late base to complete).
 * - `ignored_cancelled`: the order was already cancelled for this source; nothing reactivates it.
 */
export type ApplyOutcome = 'applied' | 'base_completed_late' | 'ignored_stale' | 'ignored_cancelled';

export interface ApplyResult {
    outcome: ApplyOutcome;
    /** The new state. When the message is ignored this is the same object that came in. */
    state: MarketplaceOrderState;
}

/** State of an order of which nothing was received yet. */
export function emptyMarketplaceOrderState(salesOrderId: string): MarketplaceOrderState {
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
 * Applies one Marketplace message to the state of its order. Pure: it never mutates its inputs and
 * touches neither the database nor the message log.
 *
 * `state` must belong to `message.data.salesOrderId`; pass `null` when nothing was received yet.
 *
 * Rules (docs/delivery-dispatch-docs, ST-72.2):
 * - The version is per source. A message with `recordVersion` lower than or equal to the stored one
 *   is ignored, and the stored version never goes down.
 * - A `confirmed` that arrives after a newer `updated` is not discarded while the base is still
 *   missing: it completes only the blocks the `updated` did not bring.
 * - Each block that is sent replaces the stored block as a whole; an absent block does not change.
 * - A cancellation is terminal for this source, even if the order never had a base.
 */
export function applyMarketplaceMessage(
    state: MarketplaceOrderState | null,
    message: MarketplaceOrderMessage,
): ApplyResult {
    const current = state ?? emptyMarketplaceOrderState(message.data.salesOrderId);

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
                baseReceived: current.baseReceived || message.kind === 'confirmed',
                blocks: { ...current.blocks, ...incoming },
            },
        };
    }

    // Not newer. Only a `confirmed` can still matter: it is the base, and it may arrive late.
    if (message.kind === 'confirmed' && !current.baseReceived) {
        return {
            outcome: 'base_completed_late',
            state: {
                ...current,
                baseReceived: true,
                // The blocks already stored are newer than this message, so they win.
                blocks: { ...incoming, ...current.blocks },
            },
        };
    }

    return { outcome: 'ignored_stale', state: current };
}

/**
 * The blocks a message brings, copied so the new state never shares objects with the message.
 * Identification fields (`salesOrderId`, `recordVersion`, `updatedAt`) are not blocks.
 */
function blocksOf(message: Exclude<MarketplaceOrderMessage, { kind: 'cancelled' }>): MarketplaceOrderBlocks {
    const { data } = message;
    const blocks: MarketplaceOrderBlocks = {};

    if (message.kind === 'confirmed') blocks.confirmedAt = message.data.confirmedAt;
    if (data.recipient !== undefined) blocks.recipient = structuredClone(data.recipient);
    if (data.deliveryAddress !== undefined) blocks.deliveryAddress = structuredClone(data.deliveryAddress);
    if (data.preferences !== undefined) blocks.preferences = structuredClone(data.preferences);
    if (data.deliveryDeadline !== undefined) blocks.deliveryDeadline = data.deliveryDeadline;
    if (data.priority !== undefined) blocks.priority = data.priority;

    return blocks;
}
