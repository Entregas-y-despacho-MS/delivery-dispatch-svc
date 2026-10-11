import { describe, expect, it } from 'vitest';
import { MemoryCacheAdapter } from './memory-cache.adapter.js';

describe('MemoryCacheAdapter', () => {
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
});
