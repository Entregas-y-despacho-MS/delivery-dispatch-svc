import { Module } from '@nestjs/common';
import { CloudinaryConfig } from './cloudinary.config.js';
import { CloudinaryAdapter } from './cloudinary.adapter.js';
import { StoragePort } from '../storage.port.js';

@Module({
    providers: [
        CloudinaryConfig,
        CloudinaryAdapter,
        { provide: StoragePort, useExisting: CloudinaryAdapter },
    ],
    exports: [StoragePort],
})
export class CloudinaryStorageModule {}
