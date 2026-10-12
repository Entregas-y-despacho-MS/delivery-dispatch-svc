import { Module } from '@nestjs/common';
import { PubSub } from '@google-cloud/pubsub';
import { MessageValidator } from '../envelope/message-validator.js';
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
        PubsubMessageBusAdapter,
        { provide: MessageBus, useExisting: PubsubMessageBusAdapter },
    ],
    // The `InboundMessageLog` port is not provided here: it comes from the global InboundMessagesModule
    // (database adapter over `inbound_messages`), so a receipt survives a restart.
    exports: [MessageBus, MessageValidator],
})
export class PubsubMessagingModule {}
