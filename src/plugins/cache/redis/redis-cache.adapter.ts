import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';
import { CacheService } from '../cache.port.js';
import { CacheUnavailableException } from '../exceptions/index.js';
import { RedisCacheConfig } from './redis-cache.config.js';

@Injectable()
export class RedisCacheAdapter extends CacheService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(RedisCacheAdapter.name);
    private readonly client: RedisClientType;

    constructor(config: RedisCacheConfig) {
        super();
        this.client = createClient({
            socket: {
                host: config.host,
                port: config.port,
                connectTimeout: 1500,
                reconnectStrategy: (retries) => Math.min(250 * 2 ** Math.min(retries, 4), 4000),
            },
        });
        this.client.on('error', () => this.logger.warn('Redis is unavailable; settings will use PostgreSQL.'));
    }

    onModuleInit(): void {
        void this.client.connect().catch(() => this.logger.warn('Redis is unavailable; settings will use PostgreSQL.'));
    }

    async onModuleDestroy(): Promise<void> {
        if (!this.client.isOpen) return;
        if (!this.client.isReady) {
            this.client.destroy();
            return;
        }
        await this.client.quit().catch(() => this.client.destroy());
    }

    async get(key: string): Promise<string | null> {
        if (!this.client.isReady) throw new CacheUnavailableException();
        try {
            return await this.client.get(key);
        } catch {
            throw new CacheUnavailableException();
        }
    }

    async set(key: string, value: string): Promise<void> {
        if (!this.client.isReady) throw new CacheUnavailableException();
        try {
            await this.client.set(key, value);
        } catch {
            throw new CacheUnavailableException();
        }
    }

    async setIfNewer(key: string, version: number, value: string): Promise<void> {
        if (!this.client.isReady) throw new CacheUnavailableException();
        try {
            await this.client.eval(
                'local v=redis.call("GET",KEYS[1]); if v then local ok,d=pcall(cjson.decode,v); if ok and tonumber(d.version) and tonumber(d.version)>tonumber(ARGV[1]) then return 0 end end; redis.call("SET",KEYS[1],ARGV[2]); return 1',
                { keys: [key], arguments: [String(version), value] },
            );
        } catch {
            throw new CacheUnavailableException();
        }
    }

    async delete(key: string): Promise<void> {
        if (!this.client.isReady) throw new CacheUnavailableException();
        try {
            await this.client.del(key);
        } catch {
            throw new CacheUnavailableException();
        }
    }
}
