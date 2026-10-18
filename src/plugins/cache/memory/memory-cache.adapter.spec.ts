import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCacheAdapter } from './memory-cache.adapter.js';

describe('MemoryCacheAdapter', () => {
    afterEach(() => vi.useRealTimers());

    it('stores, reads and removes values', async () => {
        const cache = new MemoryCacheAdapter();

        await cache.set('setting', 'value');
        await expect(cache.get('setting')).resolves.toBe('value');
        await cache.delete('setting');
        await expect(cache.get('setting')).resolves.toBeNull();
    });

    it('does not replace a snapshot with an older version', async () => {
        const cache = new MemoryCacheAdapter();

        await cache.setIfNewer('snapshot', 3, JSON.stringify({ version: 3, value: 'new' }));
        await cache.setIfNewer('snapshot', 2, JSON.stringify({ version: 2, value: 'old' }));

        await expect(cache.get('snapshot')).resolves.toBe(JSON.stringify({ version: 3, value: 'new' }));
    });

    it('expires a value by itself once its time to live is over', async () => {
        vi.useFakeTimers();
        const cache = new MemoryCacheAdapter();

        await cache.setWithTtl('code', 'abc', 60);
        vi.advanceTimersByTime(59_999);
        await expect(cache.get('code')).resolves.toBe('abc');
        vi.advanceTimersByTime(1);
        await expect(cache.get('code')).resolves.toBeNull();
    });

    it('a plain set replaces a value with a time to live and keeps it for good', async () => {
        vi.useFakeTimers();
        const cache = new MemoryCacheAdapter();

        await cache.setWithTtl('key', 'old', 10);
        await cache.set('key', 'new');
        vi.advanceTimersByTime(60_000);

        await expect(cache.get('key')).resolves.toBe('new');
    });

    it('counts up from 1 and the window starts at the first increment, not at the last', async () => {
        vi.useFakeTimers();
        const cache = new MemoryCacheAdapter();

        expect(await cache.increment('sends', 60)).toBe(1);
        vi.advanceTimersByTime(40_000);
        expect(await cache.increment('sends', 60)).toBe(2);
        vi.advanceTimersByTime(20_000);
        // 60 s after the first one: the window is over and the count starts again.
        expect(await cache.increment('sends', 60)).toBe(1);
    });

    it('hands a value to only one of two concurrent takers', async () => {
        const cache = new MemoryCacheAdapter();
        await cache.setWithTtl('proof', 'hash', 60);

        const taken = await Promise.all([cache.take('proof'), cache.take('proof')]);

        expect(taken.filter((value) => value === 'hash')).toHaveLength(1);
        await expect(cache.get('proof')).resolves.toBeNull();
    });

    it('delete also forgets the time to live', async () => {
        vi.useFakeTimers();
        const cache = new MemoryCacheAdapter();
        await cache.setWithTtl('key', 'a', 10);

        await cache.delete('key');
        await cache.set('key', 'b');
        vi.advanceTimersByTime(60_000);

        await expect(cache.get('key')).resolves.toBe('b');
    });
});
