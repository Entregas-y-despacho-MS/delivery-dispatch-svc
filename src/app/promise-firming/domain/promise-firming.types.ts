/** Outgoing topic: order of preparation to the warehouse (contracts/messages). */
export const PREPARE_REQUESTED_TOPIC = 'dispatch.shipment.prepare_requested';

/** Why the promise became firm: the 12 h window closed in silence, or the customer confirmed. */
export type PromiseFirmingReason = 'window_elapsed' | 'customer_confirmed';

/**
 * - `firmed`: promise firm and order queued.
 * - `reissued`: a new order with a higher `recordVersion` replaced the previous one (D-47).
 * - `already_firmed`: someone got there first; nothing written.
 * - `not_eligible`: state, notice, window or version do not allow it (`cause` says which); nothing written.
 * - `incomplete`: eligible but the order cannot be built (version < 1, no packages...); NOT firmed.
 */
export type PromiseFirmingResult =
    | { outcome: 'firmed'; dispatchId: number; recordVersion: number; reason: PromiseFirmingReason }
    | { outcome: 'reissued'; dispatchId: number; recordVersion: number }
    | { outcome: 'already_firmed'; dispatchId: number }
    | { outcome: 'not_eligible'; dispatchId: number; cause: string }
    | { outcome: 'incomplete'; dispatchId: number; cause: string };
