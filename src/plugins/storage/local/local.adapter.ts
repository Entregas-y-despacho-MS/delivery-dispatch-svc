import { Injectable, Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StoragePort, UploadOptions, UploadResult } from '../storage.port.js';
import { LocalStorageConfig } from './local.config.js';
import { StorageUploadException } from '../exceptions/index.js';

// Writes to disk under LocalStorageConfig.uploadsDir and returns a URL served by
// LocalStorageModule's ServeStaticModule mount (see local.module.ts) — dev only,
// most cloud hosts wipe local disk on restart/redeploy. Use `cloudinary` there.
@Injectable()
export class LocalStorageAdapter extends StoragePort {
    private readonly logger = new Logger(LocalStorageAdapter.name);

    constructor(private readonly config: LocalStorageConfig) {
        super();
    }

    async upload(options: UploadOptions): Promise<UploadResult> {
        try {
            await mkdir(this.config.uploadsDir, { recursive: true });

            const extension = options.filename.split('.').pop();
            const storedName = extension && extension !== options.filename
                ? `${randomUUID()}.${extension}`
                : randomUUID();

            await writeFile(join(this.config.uploadsDir, storedName), options.buffer);

            return { url: `${this.config.publicUrl}/uploads/${storedName}` };
        } catch (err) {
            this.logger.error(`Local storage write failed: ${err.message}`, err.stack);
            throw new StorageUploadException(err.message);
        }
    }
}
