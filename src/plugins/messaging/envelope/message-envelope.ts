import { generateMessageId } from './uuid-v7.js';

/** Services that emit messages (docs/interoperabilidad-y-flujos.md, section 1.3). */
export type MessageSource = 'marketplace' | 'inventory' | 'procurement' | 'dispatch';

/** Standard envelope of every message exchanged with the ERP. `data` is specific to each topic. */
export interface MessageEnvelope<TData = Record<string, unknown>> {
    /** UUID v7; idempotency key. */
    messageId: string;
    /** Topic or event type, e.g. `inventory.shipment.ready`. */
    type: string;
    /** Version of the `data` schema. */
    schemaVersion: number;
    source: MessageSource;
    /** ISO-8601 in UTC when the fact happened. */
    occurredAt: string;
    data: TData;
}

export interface BuildEnvelopeOptions<TData> {
    type: string;
    source: MessageSource;
    data: TData;
    /** Defaults to 1. */
    schemaVersion?: number;
    /** Defaults to now. */
    occurredAt?: Date;
    /** Defaults to a new UUID v7. Pass it to keep the same id when a message is retried. */
    messageId?: string;
}

export function buildEnvelope<TData>(options: BuildEnvelopeOptions<TData>): MessageEnvelope<TData> {
    return {
        messageId: options.messageId ?? generateMessageId(),
        type: options.type,
        schemaVersion: options.schemaVersion ?? 1,
        source: options.source,
        occurredAt: (options.occurredAt ?? new Date()).toISOString(),
        data: options.data,
    };
}
