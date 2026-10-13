import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { PostgresTaskLock } from './postgres-task-lock.adapter.js';

/**
 * Two backend instances = two DataSources (two connection pools) against the same PostgreSQL.
 * Skipped unless TEST_DB_PORT is set:
 *   TEST_DB_HOST=localhost TEST_DB_PORT=5432 TEST_DB_USER=... TEST_DB_PASSWORD=... TEST_DB_NAME=... \
 *     npx vitest run postgres-task-lock.integration
 * It uses random task names and writes no rows.
 */
const PORT = process.env.TEST_DB_PORT;

const gate = () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { opened, open };
};

const pause = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!PORT)('PostgresTaskLock against PostgreSQL, two instances', () => {
    let dataSourceA: DataSource;
    let dataSourceB: DataSource;
    let instanceA: PostgresTaskLock;
    let instanceB: PostgresTaskLock;

    const connect = async (): Promise<DataSource> => {
        const dataSource = new DataSource({
            type: 'postgres',
            host: process.env.TEST_DB_HOST ?? 'localhost',
            port: Number(PORT),
            username: process.env.TEST_DB_USER,
            password: process.env.TEST_DB_PASSWORD,
            database: process.env.TEST_DB_NAME,
            entities: [],
        });
        return await dataSource.initialize();
    };

    beforeAll(async () => {
        dataSourceA = await connect();
        dataSourceB = await connect();
        instanceA = new PostgresTaskLock(dataSourceA);
        instanceB = new PostgresTaskLock(dataSourceB);
    });

    afterAll(async () => {
        await dataSourceA?.destroy();
        await dataSourceB?.destroy();
    });

    it('only one of two instances runs the same task at the same time', async () => {
        const task = `test-${randomUUID()}`;
        const hold = gate();
        let runs = 0;
        const work = async () => {
            runs++;
            await hold.opened;
            return 'ran';
        };

        const first = instanceA.runExclusive(task, work);
        await pause(100); // let A take the lock before B tries
        const second = await instanceB.runExclusive(task, work);

        expect(second).toEqual({ acquired: false });
        hold.open();
        await expect(first).resolves.toEqual({ acquired: true, value: 'ran' });
        expect(runs).toBe(1);
    });

    it('releases the lock when the task ends, so the other instance can run it next', async () => {
        const task = `test-${randomUUID()}`;

        await expect(instanceA.runExclusive(task, async () => 'a')).resolves.toEqual({ acquired: true, value: 'a' });
        await expect(instanceB.runExclusive(task, async () => 'b')).resolves.toEqual({ acquired: true, value: 'b' });
    });

    it('releases the lock when the task throws', async () => {
        const task = `test-${randomUUID()}`;

        await expect(
            instanceA.runExclusive(task, async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
        await expect(instanceB.runExclusive(task, async () => 'b')).resolves.toEqual({ acquired: true, value: 'b' });
    });

    it('does not mix up different tasks', async () => {
        const hold = gate();
        const first = instanceA.runExclusive(`test-${randomUUID()}`, async () => await hold.opened);
        await pause(100);

        await expect(instanceB.runExclusive(`test-${randomUUID()}`, async () => 'other')).resolves.toEqual({
            acquired: true,
            value: 'other',
        });
        hold.open();
        await first;
    });

    it('lets the task keep using the normal pool while it holds the lock', async () => {
        const result = await instanceA.runExclusive(`test-${randomUUID()}`, async () => {
            const rows: { one: number }[] = await dataSourceA.query('SELECT 1 AS one');
            return rows[0].one;
        });

        expect(result).toEqual({ acquired: true, value: 1 });
    });
});
