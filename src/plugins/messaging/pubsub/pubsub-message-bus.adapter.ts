import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Message, PubSub, Subscription, Topic } from '@google-cloud/pubsub';
import type { MessageEnvelope } from '../envelope/message-envelope.js';
import { MessageValidator } from '../envelope/message-validator.js';
import {
    SubscriptionNotFoundException,
    TopicAlreadySubscribedException,
    UnknownTopicException,
} from '../exceptions/index.js';
import { InboundMessageLog } from '../inbound-message-log.port.js';
import { MessageBus, type MessageHandler } from '../message-bus.port.js';
import { MessageConsumer } from '../message-consumer.js';
import { PubsubMessagingConfig } from './pubsub-messaging.config.js';

/** Injection token of the Google Cloud Pub/Sub client. */
export const PUBSUB_CLIENT = Symbol('PUBSUB_CLIENT');

/**
 * Message bus over Google Cloud Pub/Sub (the local emulator in development). A message is
 * acknowledged only after the pipeline finishes (handler done, or message sent to the dead-letter);
 * if anything throws it is nacked and the broker redelivers it, and after the subscription's
 * `maxDeliveryAttempts` it ends in the dead-letter topic on its own.
 */
@Injectable()
export class PubsubMessageBusAdapter extends MessageBus implements OnModuleDestroy {
    private readonly logger = new Logger(PubsubMessageBusAdapter.name);
    private readonly topics = new Map<string, Topic>();
    private readonly subscriptions = new Map<string, Subscription>();
    private readonly consumer: MessageConsumer;

    constructor(
        @Inject(PUBSUB_CLIENT) private readonly client: PubSub,
        private readonly config: PubsubMessagingConfig,
        private readonly validator: MessageValidator,
        inboundLog: InboundMessageLog,
    ) {
        super();
        this.consumer = new MessageConsumer(validator, inboundLog, (topic, payload) =>
            this.publishJson(topic, payload),
        );
    }

    async publish(topic: string, envelope: MessageEnvelope): Promise<void> {
        await this.publishJson(topic, envelope, {
            messageId: envelope.messageId,
            type: envelope.type,
            source: envelope.source,
            schemaVersion: String(envelope.schemaVersion),
        });
    }

    async subscribe(topic: string, handler: MessageHandler): Promise<void> {
        if (!this.validator.hasTopic(topic)) throw new UnknownTopicException(topic);
        if (this.subscriptions.has(topic)) throw new TopicAlreadySubscribedException(topic);

        const name = `${topic}.${this.config.subscriptionSuffix}`;
        const subscription = this.client.subscription(name);
        const [exists] = await subscription.exists();
        if (!exists) throw new SubscriptionNotFoundException(name);

        subscription.on('message', (message: Message) => {
            void this.onMessage(topic, handler, message);
        });
        subscription.on('error', (error: Error) => {
            this.logger.error(`Subscription ${name} failed: ${error.message}`, error.stack);
        });
        this.subscriptions.set(topic, subscription);
        this.logger.log(`Subscribed to ${topic} (${name}).`);
    }

    async onModuleDestroy(): Promise<void> {
        await Promise.all([...this.subscriptions.values()].map((subscription) => subscription.close()));
        this.subscriptions.clear();
        await this.client.close();
    }

    private async onMessage(topic: string, handler: MessageHandler, message: Message): Promise<void> {
        const text = message.data.toString('utf8');
        let payload: unknown = text;
        try {
            payload = JSON.parse(text);
        } catch {
            // Not JSON: the pipeline rejects it and the dead-letter keeps the raw text.
        }

        try {
            await this.consumer.consume(topic, payload, handler);
            message.ack();
        } catch (error) {
            this.logger.warn(
                `Message ${message.id} on ${topic} failed and will be redelivered: ` +
                    (error instanceof Error ? error.message : String(error)),
            );
            message.nack();
        }
    }

    private async publishJson(
        topic: string,
        payload: unknown,
        attributes: Record<string, string> = {},
    ): Promise<void> {
        await this.topicHandle(topic).publishMessage({ json: payload, attributes });
    }

    private topicHandle(name: string): Topic {
        let topic = this.topics.get(name);
        if (!topic) {
            topic = this.client.topic(name);
            this.topics.set(name, topic);
        }
        return topic;
    }
}
