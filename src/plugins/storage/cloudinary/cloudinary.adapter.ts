import { Injectable, Logger } from '@nestjs/common';
import { v2 as cloudinary, UploadApiErrorResponse, UploadApiResponse } from 'cloudinary';
import { AccessUrlResult, StoragePort, UploadOptions, UploadResult } from '../storage.port.js';
import { CloudinaryConfig } from './cloudinary.config.js';
import { StorageUploadException } from '../exceptions/index.js';

const STORED_URL = /\/(image|video|raw)\/upload\/(?:v\d+\/)?(.+?)(?:\.([a-z0-9]+))?$/i;

@Injectable()
export class CloudinaryAdapter extends StoragePort {
    private readonly logger = new Logger(CloudinaryAdapter.name);

    constructor(private readonly config: CloudinaryConfig) {
        super();
        cloudinary.config({
            cloud_name: config.cloudName,
            api_key:    config.apiKey,
            api_secret: config.apiSecret,
        });
    }

    async upload(options: UploadOptions): Promise<UploadResult> {
        try {
            const result = await new Promise<UploadApiResponse>((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    { folder: this.config.folder, resource_type: 'auto' },
                    (error?: UploadApiErrorResponse, result?: UploadApiResponse) => {
                        if (error || !result) reject(error);
                        else resolve(result);
                    },
                );
                stream.end(options.buffer);
            });

            return { url: result.secure_url };
        } catch (err) {
            this.logger.error(`Cloudinary upload failed: ${err.message}`, err.stack);
            throw new StorageUploadException(err.message);
        }
    }

    async getAccessUrl(storedUrl: string, ttlSeconds: number): Promise<AccessUrlResult> {
        // Stored form: https://res.cloudinary.com/<cloud>/<resource_type>/upload/[v123/]<public_id>.<format>
        const match = STORED_URL.exec(storedUrl.split('?')[0]);
        if (!match) throw new StorageUploadException('Unrecognized stored file URL.');
        const [, resourceType, publicId, format] = match;
        const expiresAtSec = Math.floor(Date.now() / 1000) + ttlSeconds;
        // Signed download endpoint: valid until expires_at, regardless of the asset's delivery type.
        const url = cloudinary.utils.private_download_url(publicId, format ?? '', {
            resource_type: resourceType,
            type:          'upload',
            expires_at:    expiresAtSec,
        });
        return { url, expiresAt: new Date(expiresAtSec * 1000) };
    }
}
