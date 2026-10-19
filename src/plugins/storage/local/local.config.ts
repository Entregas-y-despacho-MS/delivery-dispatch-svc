import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

@Injectable()
export class LocalStorageConfig {
    readonly uploadsDir: string;
    readonly publicUrl:  string;
    readonly apiPrefix:  string;
    /** HMAC key for signed access URLs, derived from JWT_SECRET so no new env var is needed. */
    readonly signingKey: Buffer;

    constructor(cfg: ConfigService) {
        this.uploadsDir = cfg.get<string>('UPLOADS_DIR', 'uploads')!;
        this.publicUrl  = cfg.get<string>('PUBLIC_URL', 'http://localhost:3000')!;
        this.apiPrefix  = cfg.get<string>('API_PREFIX', 'api')!;
        this.signingKey = createHash('sha256').update(`storage-access:${cfg.get<string>('JWT_SECRET', '')}`).digest();
    }
}
