import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/services/app.config.js';

@Injectable()
export class DatabaseConfig {
    readonly type:     string;
    readonly host:     string;
    readonly port:     number;
    readonly username: string;
    readonly password: string;
    readonly database: string;
    readonly logging:  boolean;

    constructor(cfg: ConfigService, app: AppConfig) {
        this.type     = cfg.get<string>('DB_TYPE')!;
        this.host     = cfg.get<string>('DB_HOST')!;
        this.port     = cfg.get<number>('DB_PORT')!;
        this.username = cfg.get<string>('DB_USER')!;
        this.password = cfg.get<string>('DB_PASSWORD')!;
        this.database = cfg.get<string>('DB_NAME')!;
        // Force logging off in production regardless of DB_LOGS value.
        this.logging  = app.isProduction ? false : (cfg.get<boolean>('DB_LOGS') ?? false);
    }
}
