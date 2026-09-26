import { Injectable, Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StoragePort, UploadOptions, UploadResult } from '../storage.port.js';
import { LocalStorageConfig } from './local.config.js';
import { StorageUploadException } from '../exceptions/index.js';

const EXTENSION_BY_MIME: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png':  'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
};

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

            // The extension comes from the (checked) content type, never from the client's filename: this
            // folder is served statically, so a name like "x.html" would be served as a page.
            const extension  = options.mimeType ? EXTENSION_BY_MIME[options.mimeType] : undefined;
            const storedName = extension ? `${randomUUID()}.${extension}` : randomUUID();

            await writeFile(join(this.config.uploadsDir, storedName), options.buffer);

            return { url: `${this.config.publicUrl}/uploads/${storedName}` };
        } catch (err) {
            this.logger.error(`Local storage write failed: ${err.message}`, err.stack);
            throw new StorageUploadException(err.message);
        }
    }
}
