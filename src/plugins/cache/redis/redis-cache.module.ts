import { Module } from '@nestjs/common';
import { CacheService } from '../cache.port.js';
import { RedisCacheAdapter } from './redis-cache.adapter.js';
import { RedisCacheConfig } from './redis-cache.config.js';

@Module({
    providers: [RedisCacheConfig, RedisCacheAdapter, { provide: CacheService, useExisting: RedisCacheAdapter }],
    exports:   [CacheService],
})
export class RedisCacheModule {}
