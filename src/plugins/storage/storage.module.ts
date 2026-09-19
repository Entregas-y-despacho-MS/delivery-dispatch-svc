import { DynamicModule, Global, Module } from '@nestjs/common';
import { LocalStorageModule } from './local/local.module.js';
import { CloudinaryStorageModule } from './cloudinary/cloudinary.module.js';

export type StorageProvider = 'local' | 'cloudinary';

/**
 * Port & Adapter facade for file storage.
 * Consumers inject StoragePort — the concrete provider is resolved at startup from STORAGE_PROVIDER.
 * Re-exports the adapter module so StoragePort is available app-wide via the @Global() decorator.
 */
@Global()
@Module({})
export class StorageModule {
    static register(provider?: StorageProvider): DynamicModule {
        // register() is static — DI is not available yet, so we read process.env directly.
        // dotenv/config is imported first in main.ts so process.env is populated by the time this runs.
        const chosen: StorageProvider =
            provider ?? ((process.env.STORAGE_PROVIDER as StorageProvider) || 'local');

        const adapterModule = chosen === 'cloudinary' ? CloudinaryStorageModule : LocalStorageModule;

        return {
            module:  StorageModule,
            imports: [adapterModule],
            // Re-export the whole adapter module — NestJS 12 requires re-exporting the module
            // that provides the token, not the token itself, when it originates from an import.
            exports: [adapterModule],
        };
    }
}
