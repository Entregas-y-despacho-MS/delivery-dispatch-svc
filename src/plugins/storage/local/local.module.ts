import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';
import { LocalStorageConfig } from './local.config.js';
import { LocalStorageAdapter } from './local.adapter.js';
import { StoragePort } from '../storage.port.js';

@Module({
    imports: [
        ServeStaticModule.forRootAsync({
            extraProviders: [LocalStorageConfig],
            inject:         [LocalStorageConfig],
            useFactory: (cfg: LocalStorageConfig) => [{
                rootPath: join(process.cwd(), cfg.uploadsDir),
                serveRoot: '/uploads',
            }],
        }),
    ],
    providers: [
        LocalStorageConfig,
        LocalStorageAdapter,
        { provide: StoragePort, useExisting: LocalStorageAdapter },
    ],
    exports: [StoragePort],
})
export class LocalStorageModule {}
