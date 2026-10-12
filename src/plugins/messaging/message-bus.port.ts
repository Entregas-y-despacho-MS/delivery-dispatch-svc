import type { MessageEnvelope } from './envelope/message-envelope.js';

/** Handler of a subscribed topic. Throwing makes the broker redeliver the message. */
export type MessageHandler<TData = Record<string, unknown>> = (
    envelope: MessageEnvelope<TData>,
) => Promise<void>;

/**
 * Port of the asynchronous messaging with the ERP (Google Cloud Pub/Sub, emulated locally).
 * Consumers inject this abstract class; the adapter is chosen at startup with MESSAGING_ADAPTER.
 */
export abstract class MessageBus {
    /** Publishes a message to a topic. */
    abstract publish(topic: string, envelope: MessageEnvelope): Promise<void>;

    /**
     * Subscribes the handler to a topic of the catalog. Before the handler runs, the message is
     * validated against the JSON Schema of the topic and deduplicated by `messageId`: an invalid
     * message goes to the dead-letter topic with the list of errors and a repeated one is ignored.
     * One handler per topic.
     */
    abstract subscribe(topic: string, handler: MessageHandler): Promise<void>;
}
