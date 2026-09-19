import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CloudinaryConfig {
    readonly cloudName: string;
    readonly apiKey:    string;
    readonly apiSecret: string;
    readonly folder:    string;

    constructor(cfg: ConfigService) {
        this.cloudName = cfg.get<string>('CLOUDINARY_CLOUD_NAME', '')!;
        this.apiKey    = cfg.get<string>('CLOUDINARY_API_KEY', '')!;
        this.apiSecret = cfg.get<string>('CLOUDINARY_API_SECRET', '')!;
        this.folder    = cfg.get<string>('CLOUDINARY_FOLDER', 'delivery-dispatch')!;
    }
}
