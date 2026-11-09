import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';
import { CacheService } from '../cache.port.js';
import { CacheUnavailableException } from '../exceptions/index.js';
import { RedisCacheConfig } from './redis-cache.config.js';

/** Longest a single Redis command may take before the cache is treated as unavailable. */
export const COMMAND_TIMEOUT_MS = 2000;

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
                ...(config.tls && { tls: true }),
            },
            ...(config.password && { password: config.password }),
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
        return await this.guard(async () => await this.client.get(key));
    }

    async set(key: string, value: string): Promise<void> {
        await this.guard(async () => {
            await this.client.set(key, value);
        });
    }

    async setIfNewer(key: string, version: number, value: string): Promise<void> {
        await this.guard(async () => {
            await this.client.eval(
                'local v=redis.call("GET",KEYS[1]); if v then local ok,d=pcall(cjson.decode,v); if ok and tonumber(d.version) and tonumber(d.version)>tonumber(ARGV[1]) then return 0 end end; redis.call("SET",KEYS[1],ARGV[2]); return 1',
                { keys: [key], arguments: [String(version), value] },
            );
        });
    }

    async delete(key: string): Promise<void> {
        await this.guard(async () => {
            await this.client.del(key);
        });
    }

    async setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
        await this.guard(async () => {
            await this.client.set(key, value, { EX: Math.max(1, Math.ceil(ttlSeconds)) });
        });
    }

    async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
        // SET NX EX is one command: it answers 'OK' when it stored the value and null when the key already existed.
        return await this.guard(async () => (await this.client.set(key, value, { NX: true, EX: Math.max(1, Math.ceil(ttlSeconds)) })) === 'OK');
    }

    async increment(key: string, ttlSeconds: number): Promise<number> {
        // One script, so a crash between INCR and EXPIRE can never leave a counter that never expires.
        return await this.guard(async () => Number(await this.client.eval(
            'local n=redis.call("INCR",KEYS[1]); if n==1 then redis.call("EXPIRE",KEYS[1],ARGV[1]) end; return n',
            { keys: [key], arguments: [String(Math.max(1, Math.ceil(ttlSeconds)))] },
        )));
    }

    async take(key: string): Promise<string | null> {
        return await this.guard(async () => await this.client.getDel(key));
    }

    /**
     * Every command is bounded by `COMMAND_TIMEOUT_MS`. A Redis that is connected but not answering (paused, saturated,
     * a half-open socket) would otherwise leave the request waiting; here it counts as unavailable, so callers fall back to
     * PostgreSQL. The abandoned command is not cancelled: the client still resolves or rejects it later and that is ignored.
     * Caveat: when a timed-out command is a consuming one (`take`, `increment`, `setIfAbsent`), the caller saw a failure but
     * Redis may still apply it later (the code or the attempt is spent). Callers treat that as "ask for a new one".
     */
    private async guard<T>(operation: () => Promise<T>): Promise<T> {
        if (!this.client.isReady) throw new CacheUnavailableException();
        let timer: NodeJS.Timeout | undefined;
        try {
            const pending = operation();
            pending.catch(() => undefined);
            return await Promise.race([
                pending,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new CacheUnavailableException()), COMMAND_TIMEOUT_MS);
                }),
            ]);
        } catch {
            throw new CacheUnavailableException();
        } finally {
            clearTimeout(timer);
        }
    }
}
