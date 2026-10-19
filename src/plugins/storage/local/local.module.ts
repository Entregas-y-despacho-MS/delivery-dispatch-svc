import { Module } from '@nestjs/common';
import { LocalStorageConfig } from './local.config.js';
import { LocalStorageAdapter } from './local.adapter.js';
import { LocalStorageController } from './local.controller.js';
import { StoragePort } from '../storage.port.js';

@Module({
    controllers: [LocalStorageController],
    providers: [
        LocalStorageConfig,
        LocalStorageAdapter,
        { provide: StoragePort, useExisting: LocalStorageAdapter },
    ],
    exports: [StoragePort],
})
export class LocalStorageModule {}
