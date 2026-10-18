import { Injectable } from '@nestjs/common';
import { CacheService } from '../cache.port.js';

@Injectable()
export class MemoryCacheAdapter extends CacheService {
    private readonly values = new Map<string, string>();
    /** Epoch milliseconds at which a key stops existing; keys without an entry never expire. */
    private readonly expiresAt = new Map<string, number>();

    async get(key: string): Promise<string | null> {
        this.evictIfExpired(key);
        return this.values.get(key) ?? null;
    }

    async set(key: string, value: string): Promise<void> {
        this.values.set(key, value);
        this.expiresAt.delete(key);
    }

    async setIfNewer(key: string, version: number, value: string): Promise<void> {
        const cached = await this.get(key);
        if (cached) {
            try {
                const cachedVersion = Number((JSON.parse(cached) as { version?: number }).version);
                if (Number.isSafeInteger(cachedVersion) && cachedVersion > version) return;
            } catch {
                this.values.delete(key);
            }
        }
        this.values.set(key, value);
    }

    async delete(key: string): Promise<void> {
        this.values.delete(key);
        this.expiresAt.delete(key);
    }

    async setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
        this.values.set(key, value);
        this.expiresAt.set(key, Date.now() + ttlSeconds * 1000);
    }

    async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
        // No `await` between the check and the write: that is what makes it atomic in a single process.
        this.evictIfExpired(key);
        if (this.values.has(key)) return false;
        this.values.set(key, value);
        this.expiresAt.set(key, Date.now() + ttlSeconds * 1000);
        return true;
    }

    async increment(key: string, ttlSeconds: number): Promise<number> {
        this.evictIfExpired(key);
        const next = Number(this.values.get(key) ?? 0) + 1;
        this.values.set(key, String(next));
        if (next === 1) this.expiresAt.set(key, Date.now() + ttlSeconds * 1000);
        return next;
    }

    async take(key: string): Promise<string | null> {
        // No `await` between the read and the removal: that is what makes it atomic in a single process.
        this.evictIfExpired(key);
        const value = this.values.get(key) ?? null;
        this.values.delete(key);
        this.expiresAt.delete(key);
        return value;
    }

    private evictIfExpired(key: string): void {
        const limit = this.expiresAt.get(key);
        if (limit !== undefined && Date.now() >= limit) {
            this.values.delete(key);
            this.expiresAt.delete(key);
        }
    }
}
