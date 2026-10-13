import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { AuditLogTaskRunLog, SCHEDULED_TASK_RUN_ACTION } from './adapters/audit-log-task-run-log.adapter.js';
import { PostgresTaskLock } from './adapters/postgres-task-lock.adapter.js';
import type { ScheduledTask } from './ports/scheduled-task.js';
import { ScheduledTaskRegistry } from './services/scheduled-task-registry.service.js';
import { ScheduledTaskRunner } from './services/scheduled-task-runner.service.js';
import { SchedulerTicker } from './services/scheduler-ticker.service.js';

/**
 * The whole scheduler over a real PostgreSQL with the delivery-dispatch-db schema loaded: two
 * backend instances are two DataSources. Skipped unless TEST_DB_PORT is set:
 *   TEST_DB_HOST=localhost TEST_DB_PORT=5432 TEST_DB_USER=... TEST_DB_PASSWORD=... TEST_DB_NAME=... \
 *     npx vitest run scheduler.integration
 * It deletes the audit_logs rows it creates (task names carry a random tag).
 */
const PORT = process.env.TEST_DB_PORT;
const LA_PAZ_0830 = new Date('2026-10-13T12:30:00.000Z');

const pause = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!PORT)('scheduler against PostgreSQL, two instances', () => {
    const tag = randomUUID().slice(0, 8);
    const taskName = `plan-generation-${tag}`;
    let dataSourceA: DataSource;
    let dataSourceB: DataSource;

    const connect = async (): Promise<DataSource> =>
        await new DataSource({
            type: 'postgres',
            host: process.env.TEST_DB_HOST ?? 'localhost',
            port: Number(PORT),
            username: process.env.TEST_DB_USER,
            password: process.env.TEST_DB_PASSWORD,
            database: process.env.TEST_DB_NAME,
            entities: [],
        }).initialize();

    /** A backend instance: its own pool, the real lock and run log, a registry holding `run`. */
    const instance = (dataSource: DataSource, run: ScheduledTask['run']) => {
        const registry = new ScheduledTaskRegistry();
        registry.register({ name: taskName, schedule: { kind: 'times', settingKey: 'plan_generation_times' }, run });
        const runner = new ScheduledTaskRunner(new PostgresTaskLock(dataSource), new AuditLogTaskRunLog(dataSource));
        const settings = { getString: vi.fn().mockResolvedValue('08:30') };
        const ticker = new SchedulerTicker({ enabled: true } as never, registry, runner, settings as never);
        return { ticker, runner, registry };
    };

    const runsOfTask = async (): Promise<{ detail: string }[]> =>
        await dataSourceA.query(
            `SELECT detail FROM audit_logs WHERE action = $1 AND detail LIKE $2 ORDER BY audit_log_id`,
            [SCHEDULED_TASK_RUN_ACTION, `%${taskName}%`],
        );

    beforeAll(async () => {
        dataSourceA = await connect();
        dataSourceB = await connect();
    });

    afterEach(async () => {
        await dataSourceA.query(`DELETE FROM audit_logs WHERE action = $1 AND detail LIKE $2`, [
            SCHEDULED_TASK_RUN_ACTION,
            `%${taskName}%`,
        ]);
    });

    afterAll(async () => {
        await dataSourceA?.destroy();
        await dataSourceB?.destroy();
    });

    it('only one instance runs the task when both tick at the same moment', async () => {
        const run = vi.fn(async () => {
            await pause(150);
        });
        const a = instance(dataSourceA, run);
        const b = instance(dataSourceB, run);

        await Promise.all([a.ticker.tick(LA_PAZ_0830), b.ticker.tick(LA_PAZ_0830)]);

        expect(run).toHaveBeenCalledTimes(1);
        const rows = await runsOfTask();
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0].detail)).toMatchObject({
            task: taskName,
            occurrence: `${taskName}@2026-10-13T08:30`,
            trigger: 'schedule',
        });
    });

    it('only one instance runs the task when the second ticks after the first finished', async () => {
        const run = vi.fn().mockResolvedValue(undefined);
        const a = instance(dataSourceA, run);
        const b = instance(dataSourceB, run);

        await a.ticker.tick(LA_PAZ_0830);
        await b.ticker.tick(LA_PAZ_0830);

        expect(run).toHaveBeenCalledTimes(1);
        expect(await runsOfTask()).toHaveLength(1);
    });

    it('runs the next occurrence normally', async () => {
        const run = vi.fn().mockResolvedValue(undefined);
        const a = instance(dataSourceA, run);

        await a.ticker.tick(LA_PAZ_0830);
        await a.ticker.tick(new Date('2026-10-14T12:30:00.000Z'));

        expect(run).toHaveBeenCalledTimes(2);
    });

    it('does not record a failed run, so the other instance can retry the occurrence', async () => {
        const failing = instance(dataSourceA, async () => {
            throw new Error('boom');
        });
        const run = vi.fn().mockResolvedValue(undefined);
        const healthy = instance(dataSourceB, run);

        await failing.ticker.tick(LA_PAZ_0830);
        expect(await runsOfTask()).toHaveLength(0);

        await healthy.ticker.tick(LA_PAZ_0830);
        expect(run).toHaveBeenCalledTimes(1);
        expect(await runsOfTask()).toHaveLength(1);
    });

    it('serializes a manual run with the scheduled one and records it without an occurrence', async () => {
        const run = vi.fn(async () => {
            await pause(150);
        });
        const a = instance(dataSourceA, run);
        const b = instance(dataSourceB, run);
        const task = b.registry.get(taskName)!;

        const scheduled = a.ticker.tick(LA_PAZ_0830);
        await pause(50);
        const manualWhileRunning = await b.runner.run(task, { trigger: 'manual', occurrence: null });
        await scheduled;
        const manualAfter = await b.runner.run(task, { trigger: 'manual', occurrence: null });

        expect(manualWhileRunning).toEqual({ status: 'skipped-locked' });
        expect(manualAfter).toEqual({ status: 'executed' });
        const triggers = (await runsOfTask()).map((row) => JSON.parse(row.detail).trigger);
        expect(triggers).toEqual(['schedule', 'manual']);
    });
});
