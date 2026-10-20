import {
    Inject,
    Injectable,
    Logger,
    Optional,
    type OnApplicationBootstrap,
    type OnModuleDestroy,
} from '@nestjs/common';
import type { Message, PubSub, Subscription, Topic } from '@google-cloud/pubsub';
import type { MessageEnvelope } from '../envelope/message-envelope.js';
import { MessageValidator } from '../envelope/message-validator.js';
import {
    SubscriptionNotFoundException,
    TopicAlreadySubscribedException,
    UnknownTopicException,
} from '../exceptions/index.js';
import { InboundMessageLog } from '../inbound-message-log.port.js';
import { InboundMessageRejection } from '../inbound-message-rejection.port.js';
import { MessageBus, type MessageHandler } from '../message-bus.port.js';
import { MessageConsumer } from '../message-consumer.js';
import { PubsubMessagingConfig } from './pubsub-messaging.config.js';

/** Injection token of the Google Cloud Pub/Sub client. */
export const PUBSUB_CLIENT = Symbol('PUBSUB_CLIENT');

/**
 * Message bus over Google Cloud Pub/Sub (the local emulator in development). A message is
 * acknowledged only after the pipeline finishes (handler done, or message sent to the dead-letter);
 * if anything throws it is nacked and the broker redelivers it. A GCP subscription must configure
 * its own dead-letter policy to stop retries after the chosen number of deliveries.
 */
@Injectable()
export class PubsubMessageBusAdapter extends MessageBus implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(PubsubMessageBusAdapter.name);
    private readonly topics = new Map<string, Topic>();
    private readonly subscriptions = new Map<string, Subscription>();
    private readonly inboundHandlers = new Map<string, MessageHandler>();
    private readonly inFlight = new Set<Promise<void>>();
    private readonly consumer: MessageConsumer;
    private sharedSubscriptionPromise: Promise<Subscription> | undefined;

    constructor(
        @Inject(PUBSUB_CLIENT) private readonly client: PubSub,
        private readonly config: PubsubMessagingConfig,
        private readonly validator: MessageValidator,
        inboundLog: InboundMessageLog,
        @Optional() inboundRejection?: InboundMessageRejection,
    ) {
        super();
        this.consumer = new MessageConsumer(
            validator,
            inboundLog,
            (topic, payload) => this.publishJson(topic, payload),
            inboundRejection,
        );
    }

    async publish(topic: string, envelope: MessageEnvelope): Promise<void> {
        const status = topic === 'dispatch.transfer.status_changed' &&
            typeof envelope.data === 'object' && envelope.data !== null &&
            'status' in envelope.data && typeof envelope.data.status === 'string'
            ? envelope.data.status
            : undefined;
        await this.publishJson(topic, envelope, {
            messageId: envelope.messageId,
            type: envelope.type,
            source: envelope.source,
            schemaVersion: String(envelope.schemaVersion),
            ...(status && { status }),
        });
    }

    async subscribe(topic: string, handler: MessageHandler): Promise<void> {
        if (!this.validator.hasTopic(topic)) throw new UnknownTopicException(topic);

        if (this.config.inboundTopic || this.config.inboundSubscription) {
            if (!this.config.inboundTopic || !this.config.inboundSubscription) {
                throw new Error('PUBSUB_INBOUND_TOPIC and PUBSUB_INBOUND_SUBSCRIPTION must be configured together.');
            }
            if (this.inboundHandlers.has(topic)) throw new TopicAlreadySubscribedException(topic);

            // Register one logical handler per contract, while all handlers share one physical
            // subscription. The listener starts after every provider has registered its handlers.
            this.inboundHandlers.set(topic, handler);
            this.logger.log(`Subscribed to ${topic} via ${this.config.inboundSubscription}.`);
            return;
        }

        if (this.subscriptions.has(topic)) throw new TopicAlreadySubscribedException(topic);

        const name = `${topic}.${this.config.subscriptionSuffix}`;
        const subscription = this.client.subscription(name);
        const [exists] = await subscription.exists();
        if (!exists) throw new SubscriptionNotFoundException(name);

        subscription.on('message', (message: Message) => {
            const work = this.onMessage(topic, handler, message).finally(() => this.inFlight.delete(work));
            this.inFlight.add(work);
        });
        subscription.on('error', (error: Error) => {
            this.logger.error(`Subscription ${name} failed: ${error.message}`, error.stack);
        });
        this.subscriptions.set(topic, subscription);
        this.logger.log(`Subscribed to ${topic} (${name}).`);
    }

    async onApplicationBootstrap(): Promise<void> {
        if (this.config.inboundTopic && this.config.inboundSubscription) {
            await this.ensureSharedSubscription();
        }
    }

    async onModuleDestroy(): Promise<void> {
        // Stop receiving, let the handlers in progress finish and ack, and only then close the client.
        await Promise.all([...this.subscriptions.values()].map((subscription) => subscription.close()));
        this.subscriptions.clear();
        this.inboundHandlers.clear();
        await Promise.allSettled(this.inFlight);
        await this.client.close();
    }

    private async ensureSharedSubscription(): Promise<Subscription> {
        if (!this.sharedSubscriptionPromise) {
            const name = this.config.inboundSubscription!;
            this.sharedSubscriptionPromise = this.createSharedSubscription(name).catch((error: unknown) => {
                this.sharedSubscriptionPromise = undefined;
                throw error;
            });
        }
        return await this.sharedSubscriptionPromise;
    }

    private async createSharedSubscription(name: string): Promise<Subscription> {
        const subscription = this.client.subscription(name);
        const [exists] = await subscription.exists();
        if (!exists) throw new SubscriptionNotFoundException(name);
        subscription.on('message', (message: Message) => {
            const work = this.onSharedMessage(message).finally(() => this.inFlight.delete(work));
            this.inFlight.add(work);
        });
        subscription.on('error', (error: Error) => {
            this.logger.error(`Subscription ${name} failed: ${error.message}`, error.stack);
        });
        this.subscriptions.set(`shared:${name}`, subscription);
        return subscription;
    }

    private async onSharedMessage(message: Message): Promise<void> {
        const payload = this.parsePayload(message);
        const type = this.messageTypeOf(payload);
        const handler = type ? this.inboundHandlers.get(type) : undefined;

        if (handler) {
            await this.onMessage(type!, handler, message, payload);
            return;
        }

        const reason = `no registered handler for envelope type ${type ?? '(missing)'}`;
        this.logger.warn(`Message ${message.id} on ${this.config.inboundTopic} rejected: ${reason}.`);

        // The physical topic has no contract schema. Passing it through the common consumer
        // intentionally records an unknown-topic rejection and publishes to its physical DLQ.
        await this.onMessage(this.config.inboundTopic!, async () => undefined, message, payload);
    }

    private async onMessage(
        topic: string,
        handler: MessageHandler,
        message: Message,
        payload: unknown = this.parsePayload(message),
    ): Promise<void> {
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

    private parsePayload(message: Message): unknown {
        const text = message.data.toString('utf8');
        try {
            return JSON.parse(text) as unknown;
        } catch {
            // Not JSON: the pipeline rejects it and the dead-letter keeps the raw text.
            return text;
        }
    }

    private messageTypeOf(payload: unknown): string | undefined {
        if (typeof payload !== 'object' || payload === null || !('type' in payload)) return undefined;
        const type = (payload as { type?: unknown }).type;
        return typeof type === 'string' && type.length > 0 ? type : undefined;
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
