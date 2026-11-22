/**
 * `dispatch.rma.authorization_requested` — Dispatch asks Inventory to authorize a return after a `request_RMA`
 * verdict (contracts/messages/schemas/dispatch.rma.authorization_requested.schema.json). It is only queued in the
 * outbox, in the same transaction as the verdict.
 */
export const RMA_AUTHORIZATION_REQUESTED_TOPIC = 'dispatch.rma.authorization_requested';
