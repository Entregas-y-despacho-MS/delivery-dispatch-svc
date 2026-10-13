import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SettingsService } from '../../../modules/settings/services/settings.service.js';
import { evaluateSchedule, occurrenceKey, toLocalMoment } from '../domain/task-schedule.js';
import { SchedulerConfig } from '../scheduler.config.js';
import { ScheduledTaskRegistry } from './scheduled-task-registry.service.js';
import { ScheduledTaskRunner } from './scheduled-task-runner.service.js';

/**
 * The clock of the scheduler: once a minute it asks, for every registered task, whether the current
 * America/La_Paz minute matches its schedule and, if so, hands it to the runner.
 *
 * The times are read from `settings` on each tick (cached by `SettingsService`), so changing
 * `plan_generation_times`, `route_cutoff_time`... takes effect without redeploy. Every instance
 * ticks; the lock and the run log make sure only one of them runs each occurrence.
 */
@Injectable()
export class SchedulerTicker implements OnModuleDestroy {
    private readonly logger = new Logger(SchedulerTicker.name);
    private readonly inFlight = new Set<Promise<unknown>>();
    /** `task:value` pairs already reported as invalid, so a bad setting warns once, not every minute. */
    private readonly reportedInvalid = new Set<string>();

    constructor(
        private readonly config: SchedulerConfig,
        private readonly registry: ScheduledTaskRegistry,
        private readonly runner: ScheduledTaskRunner,
        private readonly settings: SettingsService,
    ) {}

    @Cron(CronExpression.EVERY_MINUTE)
    async handleCron(): Promise<void> {
        await this.tick(new Date());
    }

    /** Evaluates every task at `instant` and waits for the ones that were due. Exposed for tests. */
    async tick(instant: Date): Promise<void> {
        if (!this.config.enabled) return;

        const moment = toLocalMoment(instant);
        const runs: Promise<unknown>[] = [];

        for (const task of this.registry.list()) {
            const settingKey = 'settingKey' in task.schedule ? task.schedule.settingKey : null;
            const settingValue = settingKey !== null ? await this.settings.getString(settingKey, '') : null;
            const evaluation = evaluateSchedule(task.schedule, moment, settingValue);

            if (evaluation === 'invalid') {
                this.warnInvalidOnce(task.name, settingKey, settingValue);
                continue;
            }
            this.reportedInvalid.delete(`${task.name}:${settingValue}`);
            if (evaluation !== 'due') continue;

            const run = this.runner
                .run(task, { trigger: 'schedule', occurrence: occurrenceKey(task.name, moment) })
                .finally(() => this.inFlight.delete(run));
            this.inFlight.add(run);
            runs.push(run);
        }

        await Promise.all(runs);
    }

    async onModuleDestroy(): Promise<void> {
        await Promise.allSettled(this.inFlight);
    }

    private warnInvalidOnce(taskName: string, settingKey: string | null, value: string | null): void {
        const marker = `${taskName}:${value}`;
        if (this.reportedInvalid.has(marker)) return;
        this.reportedInvalid.add(marker);
        this.logger.warn(
            settingKey !== null
                ? `Task "${taskName}" will not run: setting "${settingKey}" is missing or invalid (${JSON.stringify(value)}).`
                : `Task "${taskName}" will not run: its schedule is invalid.`,
        );
    }
}
