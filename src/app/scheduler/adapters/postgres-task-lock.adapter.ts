import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type QueryRunner } from 'typeorm';
import { TaskLock, type ExclusiveResult } from '../ports/task-lock.port.js';

const LOCK_KEY_PREFIX = 'scheduled-task:';

/**
 * `TaskLock` over a session-level PostgreSQL advisory lock.
 *
 * The lock belongs to the *connection*, not to a transaction, so a task that runs for minutes does
 * not keep a transaction open. For that reason the lock is taken on a dedicated `QueryRunner`
 * (never through the pool: a pooled `pg_advisory_unlock` could land on a different connection and
 * leave the lock held forever) and released on the same one. If the process dies, PostgreSQL drops
 * the lock with the connection.
 *
 * The task itself uses the normal pool; only this one connection stays idle while it runs.
 */
@Injectable()
export class PostgresTaskLock extends TaskLock {
    private readonly logger = new Logger(PostgresTaskLock.name);

    constructor(@InjectDataSource() private readonly dataSource: DataSource) {
        super();
    }

    async runExclusive<T>(taskName: string, work: () => Promise<T>): Promise<ExclusiveResult<T>> {
        const key = `${LOCK_KEY_PREFIX}${taskName}`;
        const runner = this.dataSource.createQueryRunner();
        let held = false;
        let brokenConnection: Error | undefined;

        try {
            await runner.connect();
            const rows: { locked: boolean }[] = await runner.query(
                'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
                [key],
            );
            if (rows[0]?.locked !== true) return { acquired: false };

            held = true;
            return { acquired: true, value: await work() };
        } finally {
            if (held) brokenConnection = await this.unlock(runner, key);
            await this.release(runner, brokenConnection);
        }
    }

    /** Returns an error when the lock could not be confirmed as released (the connection is suspect). */
    private async unlock(runner: QueryRunner, key: string): Promise<Error | undefined> {
        try {
            const rows: { unlocked: boolean }[] = await runner.query(
                'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked',
                [key],
            );
            if (rows[0]?.unlocked === true) return undefined;
            return new Error(`Advisory lock "${key}" was not held by this connection when releasing it.`);
        } catch (error) {
            return error instanceof Error ? error : new Error(String(error));
        }
    }

    /**
     * A connection whose unlock failed may still hold the lock, and going back to the pool would
     * keep it held. Releasing with an error makes the pool discard (close) that connection, which
     * frees the lock on the server side.
     */
    private async release(runner: QueryRunner, brokenConnection: Error | undefined): Promise<void> {
        if (brokenConnection) {
            this.logger.error(`Discarding the connection of a task lock: ${brokenConnection.message}`);
            const postgresRunner = runner as QueryRunner & {
                releasePostgresConnection?: (error?: Error) => Promise<void>;
            };
            if (postgresRunner.releasePostgresConnection) {
                await postgresRunner.releasePostgresConnection(brokenConnection);
                return;
            }
        }
        await runner.release();
    }
}
