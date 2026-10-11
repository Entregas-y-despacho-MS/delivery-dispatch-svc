import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RedisCacheConfig {
    readonly host: string;
    readonly port: number;

    constructor(config: ConfigService) {
        this.host = config.get<string>('REDIS_HOST')!;
        this.port = config.get<number>('REDIS_PORT')!;
    }
}
