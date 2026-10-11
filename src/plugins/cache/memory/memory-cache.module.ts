import { Module } from '@nestjs/common';
import { CacheService } from '../cache.port.js';
import { MemoryCacheAdapter } from './memory-cache.adapter.js';

@Module({
    providers: [MemoryCacheAdapter, { provide: CacheService, useExisting: MemoryCacheAdapter }],
    exports:   [CacheService],
})
export class MemoryCacheModule {}
