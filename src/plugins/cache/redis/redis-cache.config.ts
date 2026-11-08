import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RedisCacheConfig {
    readonly host: string;
    readonly port: number;
    readonly password: string | undefined;
    readonly tls: boolean;

    constructor(config: ConfigService) {
        this.host     = config.get<string>('REDIS_HOST')!;
        this.port     = config.get<number>('REDIS_PORT')!;
        this.password = config.get<string>('REDIS_PASSWORD') || undefined;
        this.tls      = config.get<boolean>('REDIS_TLS')!;
    }
}
