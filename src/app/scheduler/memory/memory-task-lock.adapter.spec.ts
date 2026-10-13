import { describe, expect, it, vi } from 'vitest';
import { MemoryTaskLock } from './memory-task-lock.adapter.js';

const gate = () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { opened, open };
};

describe('MemoryTaskLock', () => {
    it('runs the work and returns its value', async () => {
        const lock = new MemoryTaskLock();
        await expect(lock.runExclusive('task', async () => 42)).resolves.toEqual({ acquired: true, value: 42 });
    });

    it('does not run the work while another caller holds the same task, and does not wait', async () => {
        const lock = new MemoryTaskLock();
        const hold = gate();
        const first = lock.runExclusive('task', async () => await hold.opened);

        const work = vi.fn(async () => 'second');
        const second = await lock.runExclusive('task', work);

        expect(second).toEqual({ acquired: false });
        expect(work).not.toHaveBeenCalled();
        hold.open();
        await first;
    });

    it('lets different tasks run at the same time', async () => {
        const lock = new MemoryTaskLock();
        const hold = gate();
        const first = lock.runExclusive('generate', async () => await hold.opened);

        await expect(lock.runExclusive('cutoff', async () => 'ok')).resolves.toEqual({ acquired: true, value: 'ok' });
        hold.open();
        await first;
    });

    it('releases the lock when the work finishes', async () => {
        const lock = new MemoryTaskLock();
        await lock.runExclusive('task', async () => 1);
        await expect(lock.runExclusive('task', async () => 2)).resolves.toEqual({ acquired: true, value: 2 });
    });

    it('releases the lock and propagates the error when the work throws', async () => {
        const lock = new MemoryTaskLock();
        await expect(
            lock.runExclusive('task', async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
        await expect(lock.runExclusive('task', async () => 'again')).resolves.toEqual({ acquired: true, value: 'again' });
    });

    it('two instances sharing the same store exclude each other', async () => {
        const store = new Set<string>();
        const instanceA = new MemoryTaskLock(store);
        const instanceB = new MemoryTaskLock(store);
        const hold = gate();
        const running = instanceA.runExclusive('task', async () => await hold.opened);

        await expect(instanceB.runExclusive('task', async () => 'b')).resolves.toEqual({ acquired: false });
        hold.open();
        await running;
        await expect(instanceB.runExclusive('task', async () => 'b')).resolves.toEqual({ acquired: true, value: 'b' });
    });
});
