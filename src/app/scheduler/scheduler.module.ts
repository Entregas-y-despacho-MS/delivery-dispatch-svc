import { Global, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuditLogTaskRunLog } from './adapters/audit-log-task-run-log.adapter.js';
import { PostgresTaskLock } from './adapters/postgres-task-lock.adapter.js';
import { TaskLock } from './ports/task-lock.port.js';
import { TaskRunLog } from './ports/task-run-log.port.js';
import { SchedulerConfig } from './scheduler.config.js';
import { ScheduledTaskRegistry } from './services/scheduled-task-registry.service.js';
import { ScheduledTaskRunner } from './services/scheduled-task-runner.service.js';
import { SchedulerTicker } from './services/scheduler-ticker.service.js';

// No own table (runs are traced in audit_logs through raw SQL): "system logic", like app/sync.
// @Global() so that the features that own a task (generator, cutoff, reminder...) only inject
// ScheduledTaskRegistry and register it, without importing this module. See rules/plugins.md.
@Global()
@Module({
    imports: [ScheduleModule.forRoot()],
    providers: [
        SchedulerConfig,
        { provide: TaskLock, useClass: PostgresTaskLock },
        { provide: TaskRunLog, useClass: AuditLogTaskRunLog },
        ScheduledTaskRegistry,
        ScheduledTaskRunner,
        SchedulerTicker,
    ],
    exports: [ScheduledTaskRegistry, ScheduledTaskRunner],
})
export class SchedulerModule {}
