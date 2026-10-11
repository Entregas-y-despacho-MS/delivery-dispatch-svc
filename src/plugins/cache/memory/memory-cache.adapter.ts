import { Injectable } from '@nestjs/common';
import { CacheService } from '../cache.port.js';

@Injectable()
export class MemoryCacheAdapter extends CacheService {
    private readonly values = new Map<string, string>();

    async get(key: string): Promise<string | null> {
        return this.values.get(key) ?? null;
    }

    async set(key: string, value: string): Promise<void> {
        this.values.set(key, value);
    }

    async setIfNewer(key: string, version: number, value: string): Promise<void> {
        const cached = this.values.get(key);
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
    }
}
