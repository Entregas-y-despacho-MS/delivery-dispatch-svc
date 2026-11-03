/** Outgoing topic: order of preparation to the warehouse (contracts/messages). */
export const PREPARE_REQUESTED_TOPIC = 'dispatch.shipment.prepare_requested';

/**
 * Why the promise became firm: the 12 h window closed in silence, the customer confirmed, or the customer
 * rescheduled (the first rescheduling of an unanswered promise is also the customer's acceptance, D-47).
 */
export type PromiseFirmingReason = 'window_elapsed' | 'customer_confirmed' | 'customer_rescheduled';

/**
 * Why an already-firm promise gets a new preparation order (`reissue`): the customer rescheduled it
 * themselves (ES-224) or the coordinator did, re-planning a `rescheduled` dispatch (ST-241.2, D-47).
 */
export type PromiseReissueReason = 'customer_rescheduled' | 'coordinator_rescheduled';

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
