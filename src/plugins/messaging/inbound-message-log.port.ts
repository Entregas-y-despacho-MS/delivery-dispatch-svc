export type InboundMessageStatus = 'processed' | 'rejected';

/** Receipt of an incoming message (table `inbound_messages`). */
export interface InboundMessageRecord {
    messageId: string;
    status: InboundMessageStatus;
    type: string;
    source: string;
    /** Required when `status` is `rejected`; must be absent when `processed`. */
    errorDetail?: string;
}

/** Append-only receipt log; the message UUID is the idempotency key. */
export abstract class InboundMessageLog {
    /** Whether a message with this id was already received (processed or rejected). */
    abstract exists(messageId: string): Promise<boolean>;

    /** Stores the receipt. Returns `false` and changes nothing if the `messageId` already exists. */
    abstract record(record: InboundMessageRecord): Promise<boolean>;
}
