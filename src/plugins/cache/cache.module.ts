import { DynamicModule, Global, Module } from '@nestjs/common';
import { MemoryCacheModule } from './memory/memory-cache.module.js';
import { RedisCacheModule } from './redis/redis-cache.module.js';

export type CacheAdapter = 'redis' | 'memory';

@Global()
@Module({})
export class CacheModule {
    static register(adapter?: CacheAdapter): DynamicModule {
        const selected = adapter ?? (process.env.CACHE_ADAPTER as CacheAdapter | undefined) ?? 'redis';
        const adapterModule = selected === 'memory' ? MemoryCacheModule : RedisCacheModule;

        return {
            module:  CacheModule,
            imports: [adapterModule],
            exports: [adapterModule],
        };
    }
}
