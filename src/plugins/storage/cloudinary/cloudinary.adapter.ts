import { Injectable, Logger } from '@nestjs/common';
import { v2 as cloudinary, UploadApiErrorResponse, UploadApiResponse } from 'cloudinary';
import { StoragePort, UploadOptions, UploadResult } from '../storage.port.js';
import { CloudinaryConfig } from './cloudinary.config.js';
import { StorageUploadException } from '../exceptions/index.js';

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
}
