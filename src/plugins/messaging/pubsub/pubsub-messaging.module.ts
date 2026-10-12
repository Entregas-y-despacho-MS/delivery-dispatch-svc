import { Module } from '@nestjs/common';
import { PubSub } from '@google-cloud/pubsub';
import { InboundMessageLog } from '../inbound-message-log.port.js';
import { MemoryInboundMessageLogAdapter } from '../memory/memory-inbound-message-log.adapter.js';
import { MessageBus } from '../message-bus.port.js';
import { messageValidatorProvider } from '../messaging.providers.js';
import { PUBSUB_CLIENT, PubsubMessageBusAdapter } from './pubsub-message-bus.adapter.js';
import { PubsubMessagingConfig } from './pubsub-messaging.config.js';

@Module({
    providers: [
        PubsubMessagingConfig,
        {
            provide: PUBSUB_CLIENT,
            inject: [PubsubMessagingConfig],
            useFactory: (config: PubsubMessagingConfig): PubSub =>
                new PubSub(
                    config.emulatorHost
                        ? { projectId: config.projectId, apiEndpoint: config.emulatorHost, emulatorMode: true }
                        : { projectId: config.projectId },
                ),
        },
        messageValidatorProvider,
        // Receipts in memory until the inbound_messages adapter (TypeORM) replaces them.
        MemoryInboundMessageLogAdapter,
        { provide: InboundMessageLog, useExisting: MemoryInboundMessageLogAdapter },
        PubsubMessageBusAdapter,
        { provide: MessageBus, useExisting: PubsubMessageBusAdapter },
    ],
    exports: [MessageBus, InboundMessageLog],
})
export class PubsubMessagingModule {}
