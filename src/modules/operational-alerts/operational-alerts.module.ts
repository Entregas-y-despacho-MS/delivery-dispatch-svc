import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SlaReportModule } from '../../app/sla-report/sla-report.module.js';
import { OperationalAlert } from './entities/operational-alert.entity.js';
import { OperationalAlertsService } from './services/operational-alerts.service.js';
import { OperationalAlertsEvaluationService } from './services/operational-alerts-evaluation.service.js';
import { OperationalAlertsEvaluationTask } from './operational-alerts-evaluation.task.js';
import { IncidentAlertListener } from './services/incident-alert.listener.js';
import { OperationalAlertsController } from './controllers/operational-alerts.controller.js';

/**
 * ES-66 (ST-66.1/ST-66.2). `SettingsService` and `ScheduledTaskRegistry` are global, so they are not
 * imported here; `SlaReportModule` is imported because `SlaReportService` is a normal (non-global)
 * provider reused for the `sla_below_threshold` evaluation.
 */
@Module({
    imports: [TypeOrmModule.forFeature([OperationalAlert]), SlaReportModule],
    controllers: [OperationalAlertsController],
    providers: [
        OperationalAlertsService,
        OperationalAlertsEvaluationService,
        OperationalAlertsEvaluationTask,
        IncidentAlertListener,
    ],
    exports: [OperationalAlertsService],
})
export class OperationalAlertsModule {}
