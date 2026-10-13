import type { TransactionOptions } from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import type { DeliveryChangeBlocks } from '../domain/dispatch-change.rules.js';
import type { ShipmentChangeBlocks } from '../domain/shipment-change.rules.js';

/** Origin of the change. */
export type ChangeSource = 'marketplace' | 'inventory';

/**
 * Payload of the internal event `dispatch.change_requires_attention`
 * (docs/interoperabilidad-y-flujos.md, section 3). It carries no personal data.
 */
export interface ChangeRequiresAttention {
    dispatchId: number;
    source: ChangeSource;
    changeType: 'order_changed' | 'order_cancelled';
    /** ISO-8601 UTC. */
    receivedAt: string;
}

export type DispatchChangeOutcome =
    /** The order is not a dispatch yet: nothing to change (its data waits in `pending_*`). */
    | { status: 'no_dispatch' }
    /** Nothing to do: the dispatch is cancelled or the change did not alter it. */
    | { status: 'ignored'; dispatchId: number; reason: 'dispatch_cancelled' | 'no_change' }
    /** The dispatch was in an editable status and it was modified. */
    | {
          status: 'applied';
          dispatchId: number;
          statusBefore: string;
          statusAfter: string;
          removedFromProposal: boolean;
          changedFields: string[];
      }
    /**
     * The dispatch is past the promise and was left untouched. The caller must emit `event` **after**
     * the transaction commits.
     */
    | { status: 'attention_required'; dispatchId: number; event: ChangeRequiresAttention };

/**
 * Applies to the dispatch of a sales order what a message of Marketplace or Almacén changed, by the
 * status of the dispatch (see `dispatch-change.rules.ts`). Both consumers call it inside their
 * `InboundMessageTransaction.process`, with the `options` they receive; the adapter writes the
 * change and the `dispatch_events` row in that same transaction.
 *
 * It never emits events: it returns them, and the consumer emits them once the transaction commits.
 */
export abstract class ExistingDispatchChanges {
    /** Marketplace changed the recipient, the address or the priority of an order. */
    abstract applyDeliveryChange(
        input: { salesOrderId: string; source: ChangeSource; blocks: DeliveryChangeBlocks; receivedAt: string },
        options: TransactionOptions,
    ): Promise<DispatchChangeOutcome>;

    /** Marketplace or Almacén cancelled the order. */
    abstract cancel(
        input: { salesOrderId: string; source: ChangeSource; cancelledAt: string; reason?: string },
        options: TransactionOptions,
    ): Promise<DispatchChangeOutcome>;

    /** Almacén reported `isReady: false` (`ready: false`) or that the order is ready again. */
    abstract setShipmentReady(
        input: { salesOrderId: string; source: ChangeSource; ready: boolean; receivedAt: string; reason?: string },
        options: TransactionOptions,
    ): Promise<DispatchChangeOutcome>;

    /**
     * A `ready` or `updated` of Almacén, after the order became a dispatch, changed its packages,
     * the handling conditions, the evidence policy or the physical packing (ST-72.5).
     *
     * - Nothing differs from the dispatch: `ignored` / `no_change`; nothing is written and no event is
     *   returned, so a resent `ready` never alters the planning.
     * - `pending`, `address_review`, `in_planning`: `applied`; the whole list of `dispatch_packages` is
     *   replaced and a dispatch of a proposed batch leaves it when its packages or conditions changed.
     * - `scheduled` and anything after it: `attention_required`; the dispatch is not modified.
     * - `cancelled`: `ignored`.
     *
     * `warehouseId` and `availableFrom` are not applied here (they have their own rule).
     */
    abstract applyShipmentChange(
        input: { salesOrderId: string; source: ChangeSource; blocks: ShipmentChangeBlocks; receivedAt: string },
        options: TransactionOptions,
    ): Promise<DispatchChangeOutcome>;
}
