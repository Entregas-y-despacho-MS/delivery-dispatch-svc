import type { MessageValidationError } from './envelope/message-validator.js';

export type InboundRejectionReasonCode = 'schema_invalid' | 'unknown_warehouse' | 'invalid_pickup_window' | 'reserved_rma_prefix';

/**
 * Domain event (`emitAsync`) every adapter fires with the full notice once a rejection is recorded.
 * A module that must answer the producer (ST-298.3: the CRM complaint) listens to it; the alert and the
 * socket event never carry the payload.
 */
export const INBOUND_MESSAGE_REJECTED_EVENT = 'inbound.message.rejected';

/** Only correlation identifiers and validation details may leave the dead-letter topic. */
export interface InboundRejectionNotice {
    messageId: string;
    type: string;
    source: string;
    salesOrderId?: string;
    reasonCode: InboundRejectionReasonCode;
    rejectedAt: string;
    errors: MessageValidationError[];
    /**
     * The rejected message exactly as it arrived. Only for in-process listeners of
     * `INBOUND_MESSAGE_REJECTED_EVENT`: it may be malformed and must never be persisted or forwarded.
     */
    message?: unknown;
}

/** Audit and announce a rejected inbound message after its dead-letter and receipt are written. */
export abstract class InboundMessageRejection {
    abstract notify(notice: InboundRejectionNotice): Promise<void>;
}
