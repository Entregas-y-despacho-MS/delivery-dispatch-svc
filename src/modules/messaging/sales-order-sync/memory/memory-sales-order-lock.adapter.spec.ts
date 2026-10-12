import { describe, expect, it } from 'vitest';
import { MemorySalesOrderLockAdapter } from './memory-sales-order-lock.adapter.js';

/** Resolves on the next macrotask, so work that "takes time" can interleave if it is not serialized. */
const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 5));

describe('MemorySalesOrderLockAdapter', () => {
    it('returns what the work returns', async () => {
        const lock = new MemorySalesOrderLockAdapter();

        await expect(lock.withLock('SO-1', async () => 42)).resolves.toBe(42);
    });

    it('runs the works of the same order one after another', async () => {
        const lock = new MemorySalesOrderLockAdapter();
        const events: string[] = [];

        const first = lock.withLock('SO-1', async () => {
            events.push('first:start');
            await tick();
            events.push('first:end');
        });
        const second = lock.withLock('SO-1', async () => {
            events.push('second:start');
            await tick();
            events.push('second:end');
        });
        await Promise.all([first, second]);

        expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    });

    it('lets different orders run at the same time', async () => {
        const lock = new MemorySalesOrderLockAdapter();
        const events: string[] = [];

        const a = lock.withLock('SO-A', async () => {
            events.push('a:start');
            await tick();
            events.push('a:end');
        });
        const b = lock.withLock('SO-B', async () => {
            events.push('b:start');
            await tick();
            events.push('b:end');
        });
        await Promise.all([a, b]);

        expect(events.slice(0, 2).sort()).toEqual(['a:start', 'b:start']);
    });

    it('does not stay locked after a failure and surfaces the error to its caller', async () => {
        const lock = new MemorySalesOrderLockAdapter();

        const failing = lock.withLock('SO-1', async () => {
            throw new Error('boom');
        });
        await expect(failing).rejects.toThrow('boom');

        await expect(lock.withLock('SO-1', async () => 'next')).resolves.toBe('next');
    });

    it('hands the work options without a manager (there is no transaction in memory)', async () => {
        const lock = new MemorySalesOrderLockAdapter();

        const options = await lock.withLock('SO-1', async (received) => received);

        expect(options.manager).toBeUndefined();
    });
});
