import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../../config/services/app.config.js';

@Injectable()
export class JwtConfig {
    readonly isActive:         boolean;
    readonly secret:           string;
    readonly expiresIn:        string;
    readonly refreshSecret:    string;
    readonly refreshExpiresIn: string;

    constructor(cfg: ConfigService, app: AppConfig) {
        this.secret           = cfg.get<string>('JWT_SECRET')!;
        this.expiresIn        = cfg.get<string>('JWT_TIME_EXPIRE')!;
        this.refreshSecret    = cfg.get<string>('JWT_REFRESH_SECRET')!;
        this.refreshExpiresIn = cfg.get<string>('JWT_REFRESH_TIME_EXPIRE')!;
        // Force active in production to prevent accidental bypass via ACTIVE_JWT=false.
        this.isActive         = app.isProduction ? true : (cfg.get<boolean>('ACTIVE_JWT') ?? true);
    }
}
