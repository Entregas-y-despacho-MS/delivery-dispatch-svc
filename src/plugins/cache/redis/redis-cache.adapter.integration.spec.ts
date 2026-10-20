import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import { RedisCacheAdapter } from './redis-cache.adapter.js';
import type { RedisCacheConfig } from './redis-cache.config.js';

/**
 * The four operations ST-224.1 added to the cache against a REAL Redis (the unit specs only cover the memory twin).
 * Skipped unless `REDIS_TEST_PORT` points at a disposable Redis; it only writes keys under a per-run prefix.
 *   REDIS_TEST_PORT=6390 npx vitest run src/plugins/cache/redis/redis-cache.adapter.integration.spec.ts
 */
const port = Number(process.env.REDIS_TEST_PORT);
const host = process.env.REDIS_TEST_HOST ?? '127.0.0.1';
const prefix = `verif:${Date.now()}:`;

describe.skipIf(!port)('RedisCacheAdapter against a real Redis', () => {
    let cache: RedisCacheAdapter;
    let raw: ReturnType<typeof createClient>;
    const keys: string[] = [];
    const key = (name: string): string => {
        const full = `${prefix}${name}`;
        keys.push(full);
        return full;
    };

    beforeAll(async () => {
        cache = new RedisCacheAdapter({ host, port } as RedisCacheConfig);
        cache.onModuleInit();
        raw = createClient({ socket: { host, port } });
        await raw.connect();
        for (let i = 0; i < 50; i += 1) {
            try {
                await cache.get(key('ready'));
                return;
            } catch {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }
        throw new Error('Redis did not become ready.');
    });

    afterAll(async () => {
        if (raw?.isOpen) {
            if (keys.length) await raw.del(keys);
            await raw.quit();
        }
        await cache?.onModuleDestroy();
    });

    it('setWithTtl stores the value with an expiry', async () => {
        const k = key('ttl');
        await cache.setWithTtl(k, 'abc', 60);
        expect(await cache.get(k)).toBe('abc');
        const ttl = await raw.ttl(k);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(60);
    });

    it('setIfAbsent stores once and never overwrites', async () => {
        const k = key('nx');
        expect(await cache.setIfAbsent(k, 'first', 60)).toBe(true);
        expect(await cache.setIfAbsent(k, 'second', 60)).toBe(false);
        expect(await cache.get(k)).toBe('first');
        expect(await raw.ttl(k)).toBeGreaterThan(0);
    });

    it('setIfAbsent lets only one of many concurrent callers win', async () => {
        const k = key('nx-race');
        const results = await Promise.all(Array.from({ length: 20 }, (_, i) => cache.setIfAbsent(k, String(i), 60)));
        expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('increment counts atomically and the window starts at the first increment', async () => {
        const k = key('counter');
        expect(await cache.increment(k, 60)).toBe(1);
        const firstTtl = await raw.ttl(k);
        expect(firstTtl).toBeGreaterThan(0);
        expect(await cache.increment(k, 600)).toBe(2);
        expect(await raw.ttl(k)).toBeLessThanOrEqual(firstTtl);

        const racing = key('counter-race');
        const counts = await Promise.all(Array.from({ length: 25 }, () => cache.increment(racing, 60)));
        expect([...counts].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    });

    it('take reads and removes in one step, so only one caller gets the value', async () => {
        const k = key('take');
        await cache.setWithTtl(k, 'proof', 60);
        const taken = await Promise.all([cache.take(k), cache.take(k), cache.take(k)]);
        expect(taken.filter((value) => value === 'proof')).toHaveLength(1);
        expect(taken.filter((value) => value === null)).toHaveLength(2);
        expect(await cache.get(k)).toBeNull();
    });
});
