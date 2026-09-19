import { DynamicModule, Global, Module } from '@nestjs/common';
import { ExpoPushModule } from './expo/expo.module.js';
import { FirebasePushModule } from './firebase/firebase.module.js';

export type PushProvider = 'expo' | 'firebase';

/**
 * Port & Adapter facade for push notifications.
 * Consumers inject PushPort — the concrete provider is resolved at startup from PUSH_PROVIDER.
 * Re-exports the adapter module so PushPort is available app-wide via the @Global() decorator.
 */
@Global()
@Module({})
export class PushModule {
    static register(provider?: PushProvider): DynamicModule {
        // register() is static — DI is not available yet, so we read process.env directly.
        // dotenv/config is imported first in main.ts so process.env is populated by the time this runs.
        const chosen: PushProvider =
            provider ?? ((process.env.PUSH_PROVIDER as PushProvider) || 'expo');

        const adapterModule = chosen === 'firebase' ? FirebasePushModule : ExpoPushModule;

        return {
            module:  PushModule,
            imports: [adapterModule],
            // Re-export the whole adapter module — NestJS 12 requires re-exporting the module
            // that provides the token, not the token itself, when it originates from an import.
            exports: [adapterModule],
        };
    }
}
