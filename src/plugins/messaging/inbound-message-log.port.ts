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

/**
 * Receipt log of incoming messages; the message UUID is the idempotency key.
 *
 * Delivery is at-least-once: the receipt is written after the handler finishes, so a crash between
 * the two (or two instances receiving the same message at once) can run a handler twice. Handlers
 * must therefore be idempotent on their own — the `recordVersion` rule of the contracts does that.
 */
export abstract class InboundMessageLog {
    /**
     * Whether the message was already **processed**. A rejected message does not count: the sender
     * may fix it and resend it with the same `messageId`, and that resend must reach the handler.
     */
    abstract wasProcessed(messageId: string): Promise<boolean>;

    /**
     * Stores the receipt. Returns `false` and changes nothing if one already exists, except that a
     * `processed` receipt replaces a `rejected` one (the corrected resend).
     */
    abstract record(record: InboundMessageRecord): Promise<boolean>;
}
