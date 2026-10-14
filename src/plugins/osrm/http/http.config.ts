import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OSRM_TABLE_MAX_COORDINATES_DEFAULT, OSRM_TIMEOUT_MS_DEFAULT } from '../osrm-limits.js';

@Injectable()
export class OsrmHttpConfig {
    readonly baseUrl: string;
    /** Max coordinates (and rows/columns per block) a `table` request may carry. */
    readonly tableMaxCoordinates: number;
    /** Abort a request that takes longer than this and answer 503. */
    readonly timeoutMs: number;

    constructor(cfg: ConfigService) {
        this.baseUrl = cfg.get<string>('OSRM_URL', 'http://localhost:5001')!;
        this.tableMaxCoordinates = Number(
            cfg.get('OSRM_TABLE_MAX_COORDINATES', OSRM_TABLE_MAX_COORDINATES_DEFAULT),
        );
        this.timeoutMs = Number(cfg.get('OSRM_TIMEOUT_MS', OSRM_TIMEOUT_MS_DEFAULT));
    }
}
