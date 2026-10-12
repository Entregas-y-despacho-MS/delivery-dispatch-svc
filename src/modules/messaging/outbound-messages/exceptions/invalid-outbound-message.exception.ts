import type { MessageValidationError } from '../../../../plugins/messaging/envelope/message-validator.js';

/** A message that does not match the schema of its topic can never be accepted by the ERP: it is never queued. */
export class InvalidOutboundMessageException extends Error {
    constructor(
        readonly type: string,
        readonly errors: MessageValidationError[],
    ) {
        super(
            `Outbound message of type "${type}" does not match its schema: ` +
                errors.map((error) => `${error.path || '/'} ${error.message}`).join('; '),
        );
        this.name = InvalidOutboundMessageException.name;
    }
}
