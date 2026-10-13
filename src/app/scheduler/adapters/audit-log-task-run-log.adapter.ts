import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { escapeLike } from '../../../shared/utils/like.util.js';
import { TaskRunLog, type TaskRunRecord } from '../ports/task-run-log.port.js';

/** `audit_logs.action` of a finished run (`user_id` NULL: the system did it). */
export const SCHEDULED_TASK_RUN_ACTION = 'scheduled_task_run';

/**
 * `TaskRunLog` over `audit_logs`. Besides the dedupe, it leaves a trace of every run (scheduled or
 * manual), which is also what a demo needs to show. No schema change.
 *
 * Only recent rows are looked at: an occurrence is one specific minute, so an hour is plenty and
 * keeps the lookup away from the whole table.
 */
@Injectable()
export class AuditLogTaskRunLog extends TaskRunLog {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {
        super();
    }

    async wasRecorded(occurrence: string): Promise<boolean> {
        const rows: unknown[] = await this.dataSource.query(
            `SELECT 1
               FROM audit_logs
              WHERE action = $1
                AND user_id IS NULL
                AND created_at >= NOW() - INTERVAL '1 hour'
                AND detail LIKE $2
              LIMIT 1`,
            [SCHEDULED_TASK_RUN_ACTION, `%"occurrence":"${escapeLike(occurrence)}"%`],
        );
        return rows.length > 0;
    }

    async record(run: TaskRunRecord): Promise<void> {
        await this.dataSource.query('INSERT INTO audit_logs (user_id, action, detail) VALUES (NULL, $1, $2)', [
            SCHEDULED_TASK_RUN_ACTION,
            JSON.stringify({
                task: run.taskName,
                occurrence: run.occurrence,
                trigger: run.trigger,
                startedAt: run.startedAt.toISOString(),
                finishedAt: run.finishedAt.toISOString(),
            }),
        ]);
    }
}
