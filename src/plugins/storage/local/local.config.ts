import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class LocalStorageConfig {
    readonly uploadsDir: string;
    readonly publicUrl:  string;

    constructor(cfg: ConfigService) {
        this.uploadsDir = cfg.get<string>('UPLOADS_DIR', 'uploads')!;
        this.publicUrl  = cfg.get<string>('PUBLIC_URL', 'http://localhost:3000')!;
    }
}
