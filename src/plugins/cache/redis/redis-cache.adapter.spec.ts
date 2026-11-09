import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheUnavailableException } from '../exceptions/index.js';
import { COMMAND_TIMEOUT_MS, RedisCacheAdapter } from './redis-cache.adapter.js';
import type { RedisCacheConfig } from './redis-cache.config.js';

const fakeClient = vi.hoisted(() => ({
    isReady: true,
    isOpen: true,
    on: vi.fn(),
    connect: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    getDel: vi.fn(),
    eval: vi.fn(),
}));

vi.mock('redis', () => ({ createClient: () => fakeClient }));

const never = (): Promise<never> => new Promise(() => undefined);

describe('RedisCacheAdapter command timeout', () => {
    let cache: RedisCacheAdapter;

    beforeEach(() => {
        vi.useFakeTimers();
        fakeClient.isReady = true;
        for (const fn of [fakeClient.get, fakeClient.set, fakeClient.del, fakeClient.getDel, fakeClient.eval]) fn.mockReset();
        cache = new RedisCacheAdapter({ host: 'localhost', port: 6379 } as RedisCacheConfig);
    });

    afterEach(() => vi.useRealTimers());

    it('answers normally when Redis is quick', async () => {
        fakeClient.get.mockResolvedValue('value');

        await expect(cache.get('k')).resolves.toBe('value');
    });

    it.each([
        ['get', () => { fakeClient.get.mockImplementation(never); return cache.get('k'); }],
        ['set', () => { fakeClient.set.mockImplementation(never); return cache.set('k', 'v'); }],
        ['delete', () => { fakeClient.del.mockImplementation(never); return cache.delete('k'); }],
        ['setWithTtl', () => { fakeClient.set.mockImplementation(never); return cache.setWithTtl('k', 'v', 60); }],
        ['take', () => { fakeClient.getDel.mockImplementation(never); return cache.take('k'); }],
        ['increment', () => { fakeClient.eval.mockImplementation(never); return cache.increment('k', 60); }],
    ])('%s becomes CacheUnavailableException when Redis never answers', async (_name, call) => {
        const outcome = expect(call()).rejects.toBeInstanceOf(CacheUnavailableException);

        await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);

        await outcome;
    });

    it('does not time out before the limit', async () => {
        fakeClient.get.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve('late'), COMMAND_TIMEOUT_MS - 100)));
        const outcome = cache.get('k');

        await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS - 100);

        await expect(outcome).resolves.toBe('late');
    });

    it('turns a Redis error into CacheUnavailableException and leaves no timer behind', async () => {
        fakeClient.get.mockRejectedValue(new Error('boom'));

        await expect(cache.get('k')).rejects.toBeInstanceOf(CacheUnavailableException);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('fails at once, without waiting, when the client is not ready', async () => {
        fakeClient.isReady = false;

        await expect(cache.get('k')).rejects.toBeInstanceOf(CacheUnavailableException);
        expect(fakeClient.get).not.toHaveBeenCalled();
    });
});
