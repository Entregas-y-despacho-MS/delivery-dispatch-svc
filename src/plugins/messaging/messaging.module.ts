import { DynamicModule, Global, Module } from '@nestjs/common';
import { UnknownMessagingAdapterException } from './exceptions/index.js';
import { MemoryMessagingModule } from './memory/memory-messaging.module.js';
import { PubsubMessagingModule } from './pubsub/pubsub-messaging.module.js';

export type MessagingAdapter = 'pubsub' | 'memory';

/**
 * Port & Adapter facade for the asynchronous messaging with the ERP.
 * Consumers inject MessageBus — the adapter is resolved at startup from MESSAGING_ADAPTER
 * (`pubsub` by default: the emulator in development, Google Cloud Pub/Sub otherwise).
 */
@Global()
@Module({})
export class MessagingModule {
    static register(adapter?: MessagingAdapter): DynamicModule {
        // register() is static — DI is not available yet, so we read process.env directly.
        const selected = adapter ?? (process.env.MESSAGING_ADAPTER as MessagingAdapter | undefined) ?? 'pubsub';
        const adapterModule = MessagingModule.adapterModule(selected);

        return {
            module:  MessagingModule,
            imports: [adapterModule],
            exports: [adapterModule],
        };
    }

    private static adapterModule(adapter: string): typeof MemoryMessagingModule | typeof PubsubMessagingModule {
        if (adapter === 'pubsub') return PubsubMessagingModule;
        if (adapter === 'memory') return MemoryMessagingModule;
        throw new UnknownMessagingAdapterException(adapter);
    }
}
