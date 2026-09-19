import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class OsrmHttpConfig {
    readonly baseUrl: string;

    constructor(cfg: ConfigService) {
        this.baseUrl = cfg.get<string>('OSRM_URL', 'http://localhost:5001')!;
    }
}
