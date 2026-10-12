import type { MessageValidationError } from '../envelope/message-validator.js';

/** A handler throws this for a business-invalid message that must go to the dead-letter. */
export class RejectedMessageException extends Error {
    constructor(
        readonly errors: MessageValidationError[],
        readonly reasonCode: 'unknown_warehouse',
    ) {
        super('Inbound message rejected by business validation.');
        this.name = 'RejectedMessageException';
    }
}
