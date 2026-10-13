import { describe, expect, it, vi } from 'vitest';
import { PostgresTaskLock } from './postgres-task-lock.adapter.js';

type Reply = { locked?: boolean; unlocked?: boolean } | Error;

/** A dedicated connection whose answers to try-lock / unlock are scripted. */
const connection = (replies: { lock?: Reply; unlock?: Reply } = {}) => {
    const runner = {
        connect: vi.fn().mockResolvedValue(undefined),
        release: vi.fn().mockResolvedValue(undefined),
        releasePostgresConnection: vi.fn().mockResolvedValue(undefined),
        query: vi.fn(async (sql: string, _parameters?: unknown[]) => {
            const reply = sql.includes('pg_try_advisory_lock')
                ? (replies.lock ?? { locked: true })
                : (replies.unlock ?? { unlocked: true });
            if (reply instanceof Error) throw reply;
            return [reply];
        }),
    };
    const dataSource = { createQueryRunner: vi.fn(() => runner) };
    return { runner, lock: new PostgresTaskLock(dataSource as never) };
};

const sqlOf = (runner: ReturnType<typeof connection>['runner']): string[] =>
    runner.query.mock.calls.map(([sql]) => sql);

describe('PostgresTaskLock', () => {
    it('takes the lock on a dedicated connection, runs the work, unlocks on that same connection and releases it', async () => {
        const { runner, lock } = connection();

        const result = await lock.runExclusive('plan-generation', async () => 'done');

        expect(result).toEqual({ acquired: true, value: 'done' });
        expect(runner.query.mock.calls[0]).toEqual([
            expect.stringContaining('pg_try_advisory_lock'),
            ['scheduled-task:plan-generation'],
        ]);
        expect(sqlOf(runner)).toEqual([
            expect.stringContaining('pg_try_advisory_lock'),
            expect.stringContaining('pg_advisory_unlock'),
        ]);
        expect(runner.release).toHaveBeenCalledOnce();
        expect(runner.releasePostgresConnection).not.toHaveBeenCalled();
    });

    it('does not run the work, does not unlock and gives the connection back when another instance holds it', async () => {
        const { runner, lock } = connection({ lock: { locked: false } });
        const work = vi.fn();

        const result = await lock.runExclusive('plan-generation', work);

        expect(result).toEqual({ acquired: false });
        expect(work).not.toHaveBeenCalled();
        expect(sqlOf(runner)).toEqual([expect.stringContaining('pg_try_advisory_lock')]);
        expect(runner.release).toHaveBeenCalledOnce();
    });

    it('unlocks and releases when the work throws, and propagates the error', async () => {
        const { runner, lock } = connection();

        await expect(
            lock.runExclusive('task', async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');

        expect(sqlOf(runner)).toEqual([
            expect.stringContaining('pg_try_advisory_lock'),
            expect.stringContaining('pg_advisory_unlock'),
        ]);
        expect(runner.release).toHaveBeenCalledOnce();
    });

    it('discards the connection (does not return it to the pool) when the unlock query fails', async () => {
        const { runner, lock } = connection({ unlock: new Error('connection lost') });

        const result = await lock.runExclusive('task', async () => 'done');

        expect(result).toEqual({ acquired: true, value: 'done' });
        expect(runner.releasePostgresConnection).toHaveBeenCalledWith(
            expect.objectContaining({ message: 'connection lost' }),
        );
        expect(runner.release).not.toHaveBeenCalled();
    });

    it('discards the connection when PostgreSQL says the lock was not held by it', async () => {
        const { runner, lock } = connection({ unlock: { unlocked: false } });

        await lock.runExclusive('task', async () => 'done');

        expect(runner.releasePostgresConnection).toHaveBeenCalledOnce();
    });

    it('gives the connection back and propagates the error when taking the lock fails', async () => {
        const { runner, lock } = connection({ lock: new Error('db down') });

        await expect(lock.runExclusive('task', async () => 'x')).rejects.toThrow('db down');

        expect(runner.release).toHaveBeenCalledOnce();
    });
});
