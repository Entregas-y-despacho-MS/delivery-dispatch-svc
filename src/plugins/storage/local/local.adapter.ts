import { Injectable, Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { AccessUrlResult, StoragePort, UploadOptions, UploadResult } from '../storage.port.js';
import { LocalStorageConfig } from './local.config.js';
import { StorageUploadException } from '../exceptions/index.js';

const EXTENSION_BY_MIME: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png':  'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
};

// Names this adapter generates (uuid + optional extension) — anything else is never read from disk.
const STORED_NAME = /^[0-9a-f-]{36}(\.[a-z0-9]{1,5})?$/;

// Writes to disk under LocalStorageConfig.uploadsDir — dev only, most cloud hosts wipe local disk on
// restart/redeploy. Use `cloudinary` there. Files are NOT served statically: they are read through
// LocalStorageController, which only answers to a signed, expiring URL (see getAccessUrl).
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

    async getAccessUrl(storedUrl: string, ttlSeconds: number): Promise<AccessUrlResult> {
        const name      = storedUrl.split('?')[0].split('/').pop() ?? '';
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
        const exp       = Math.floor(expiresAt.getTime() / 1000);
        const sig       = this.sign(name, exp);
        const url       = `${this.config.publicUrl}/${this.config.apiPrefix}/uploads/${name}?exp=${exp}&sig=${sig}`;
        return { url, expiresAt };
    }

    /** True when `sig` is the signature issued for this file and `exp` (unix seconds) has not passed. */
    verifyAccess(name: string, exp: number, sig: string): boolean {
        if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
        const expected = Buffer.from(this.sign(name, exp));
        const received = Buffer.from(sig);
        return expected.length === received.length && timingSafeEqual(expected, received);
    }

    /** Absolute path of a stored file, or null when the name is not one this adapter generated. */
    resolvePath(name: string): string | null {
        return STORED_NAME.test(name) ? join(process.cwd(), this.config.uploadsDir, name) : null;
    }

    private sign(name: string, exp: number): string {
        return createHmac('sha256', this.config.signingKey).update(`${name}.${exp}`).digest('hex');
    }
}
