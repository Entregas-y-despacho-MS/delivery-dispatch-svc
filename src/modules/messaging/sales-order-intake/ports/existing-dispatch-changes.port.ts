import type { TransactionOptions } from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import type { DeliveryChangeBlocks } from '../domain/dispatch-change.rules.js';
import type { ShipmentChangeBlocks } from '../domain/shipment-change.rules.js';

/** Origin of the change. */
export type ChangeSource = 'marketplace' | 'inventory' | 'procurement';

/**
 * Payload of the internal event `dispatch.change_requires_attention`
 * (docs/interoperabilidad-y-flujos.md, section 3). It carries no personal data.
 */
export interface ChangeRequiresAttention {
  /** Present for an existing dispatch; absent while the sales order is still incomplete. */
  dispatchId?: number;
  /**
   * Present when attention is needed before a dispatch has been created, or when a reference never
   * resolved to one at all (`orphan_receipt`). For `orphan_receipt` this is NOT a sales order id: it
   * is the warehouse receipt's own `referenceId` (an `rmaId` or a purchase order id) — the field is
   * reused as-is rather than adding a dedicated one, so a consumer of this event must not assume it
   * is always a Marketplace sales order.
   */
  salesOrderId?: string;
  source: ChangeSource;
  /**
   * `orphan_receipt` (ST-240.2): a warehouse receipt whose reference matched no dispatch, or whose
   * dispatch was not `picked_up_in_transit`. `receipt_correction` (ST-240.2): a later, higher-version
   * message for a receipt already applied — the dispatch link and status were left untouched on
   * purpose; only the receipt's own notes/items were updated. A coordinator should still look at it.
   */
  changeType: 'order_changed' | 'order_cancelled' | 'incomplete_order' | 'orphan_receipt' | 'receipt_correction';
  /** ISO-8601 UTC. */
  receivedAt: string;
}

export type DispatchChangeOutcome =
  /** The order is not a dispatch yet: nothing to change (its data waits in `pending_*`). */
  | { status: 'no_dispatch' }
  /** Nothing to do: the dispatch is cancelled or the change did not alter it. */
  | {
      status: 'ignored';
      dispatchId: number;
      reason: 'dispatch_cancelled' | 'no_change';
    }
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
  | {
      status: 'attention_required';
      dispatchId: number;
      event: ChangeRequiresAttention;
    };

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
    input: {
      salesOrderId: string;
      source: ChangeSource;
      blocks: DeliveryChangeBlocks;
      receivedAt: string;
    },
    options: TransactionOptions,
  ): Promise<DispatchChangeOutcome>;

  /** Marketplace or Almacén cancelled the order. */
  abstract cancel(
    input: {
      salesOrderId: string;
      source: ChangeSource;
      cancelledAt: string;
      reason?: string;
    },
    options: TransactionOptions,
  ): Promise<DispatchChangeOutcome>;

  /** Almacén reported `isReady: false` (`ready: false`) or that the order is ready again. */
  abstract setShipmentReady(
    input: {
      salesOrderId: string;
      source: ChangeSource;
      ready: boolean;
      receivedAt: string;
      reason?: string;
    },
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
   * A different `warehouseId` (origin warehouse code) follows the same rules and always takes a
   * dispatch of a proposed batch out of it. `availableFrom` has no column and is not applied.
   */
  abstract applyShipmentChange(
    input: {
      salesOrderId: string;
      source: ChangeSource;
      blocks: ShipmentChangeBlocks;
      receivedAt: string;
    },
    options: TransactionOptions,
  ): Promise<DispatchChangeOutcome>;
}
