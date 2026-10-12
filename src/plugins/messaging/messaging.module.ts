import { DynamicModule, Global, Module } from '@nestjs/common';
import { MemoryMessagingModule } from './memory/memory-messaging.module.js';

export type MessagingAdapter = 'memory';

/**
 * Port & Adapter facade for the asynchronous messaging with the ERP.
 * Consumers inject MessageBus — the adapter is resolved at startup from MESSAGING_ADAPTER.
 */
@Global()
@Module({})
export class MessagingModule {
    static register(adapter?: MessagingAdapter): DynamicModule {
        // register() is static — DI is not available yet, so we read process.env directly.
        const selected = adapter ?? (process.env.MESSAGING_ADAPTER as MessagingAdapter | undefined) ?? 'memory';
        const adapterModule = MessagingModule.adapterModule(selected);

        return {
            module:  MessagingModule,
            imports: [adapterModule],
            exports: [adapterModule],
        };
    }

    private static adapterModule(adapter: string): typeof MemoryMessagingModule {
        if (adapter === 'memory') return MemoryMessagingModule;
        throw new Error(`Unknown MESSAGING_ADAPTER "${adapter}". Valid values: memory.`);
    }
}
