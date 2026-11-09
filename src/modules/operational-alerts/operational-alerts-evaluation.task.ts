import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OPERATIONAL_ALERTS_EVALUATION_TASK } from '../../app/scheduler/scheduled-task-names.js';
import { ScheduledTaskRegistry } from '../../app/scheduler/services/scheduled-task-registry.service.js';
import { OperationalAlertsEvaluationService } from './services/operational-alerts-evaluation.service.js';

/**
 * Registers the periodic evaluator in the scheduler (ST-66.2, ES-66, Escenario 2) — every minute,
 * no setting-driven time list (unlike plan-generation/route-cutoff), since the alerts it raises are
 * time-sensitive by nature. The three evaluations are independent: one failing must not stop the
 * others, so each is awaited and logged on its own instead of in a single try.
 */
@Injectable()
export class OperationalAlertsEvaluationTask implements OnModuleInit {
    private readonly logger = new Logger(OperationalAlertsEvaluationTask.name);

    constructor(
        private readonly registry: ScheduledTaskRegistry,
        private readonly evaluation: OperationalAlertsEvaluationService,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: OPERATIONAL_ALERTS_EVALUATION_TASK,
            schedule: { kind: 'every-minutes', minutes: 1 },
            run: async () => await this.run(),
        });
    }

    private async run(): Promise<{ gpsStale: boolean; driverIncidents: boolean; slaBelowThreshold: boolean }> {
        const gpsStale = await this.runOne('gps_stale', () => this.evaluation.evaluateGpsStale());
        const driverIncidents = await this.runOne('driver_incidents', () => this.evaluation.evaluateDriverIncidents());
        const slaBelowThreshold = await this.runOne('sla_below_threshold', () => this.evaluation.evaluateSlaBelowThreshold());
        return { gpsStale, driverIncidents, slaBelowThreshold };
    }

    private async runOne(label: string, work: () => Promise<void>): Promise<boolean> {
        try {
            await work();
            return true;
        } catch (error) {
            this.logger.error(`Operational alerts evaluation (${label}) failed.`, error as Error);
            return false;
        }
    }
}
