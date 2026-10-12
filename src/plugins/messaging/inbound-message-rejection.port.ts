import type { MessageValidationError } from './envelope/message-validator.js';

export type InboundRejectionReasonCode = 'schema_invalid' | 'unknown_warehouse';

/** Only correlation identifiers and validation details may leave the dead-letter topic. */
export interface InboundRejectionNotice {
    messageId: string;
    type: string;
    source: string;
    salesOrderId?: string;
    reasonCode: InboundRejectionReasonCode;
    rejectedAt: string;
    errors: MessageValidationError[];
}

/** Audit and announce a rejected inbound message after its dead-letter and receipt are written. */
export abstract class InboundMessageRejection {
    abstract notify(notice: InboundRejectionNotice): Promise<void>;
}
