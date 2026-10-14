import { Module } from '@nestjs/common';
import { RouteBatchesModule } from '../../modules/dispatch/route-batches/route-batches.module.js';
import { PlanGenerationTask } from './plan-generation.task.js';
import { LotPlanner } from './ports/lot-planner.js';
import { InsertionLotPlanner } from './services/insertion-lot-planner.js';
import { PlanCandidatesRepository } from './services/plan-candidates.repository.js';
import { PlanGenerationService } from './services/plan-generation.service.js';
import { PlanningAlertsService } from './services/planning-alerts.service.js';
import { PlanWriterService } from './services/plan-writer.service.js';

/**
 * Provisional batch generator (ST-50.2, D-41). OsrmPort, SettingsService, the scheduler registry
 * and the event emitter are global; the task registers itself in `onModuleInit`.
 */
@Module({
    imports: [RouteBatchesModule],
    providers: [
        PlanCandidatesRepository,
        PlanWriterService,
        PlanningAlertsService,
        InsertionLotPlanner,
        { provide: LotPlanner, useExisting: InsertionLotPlanner },
        PlanGenerationService,
        PlanGenerationTask,
    ],
    exports: [LotPlanner, PlanCandidatesRepository, PlanWriterService, PlanGenerationService, PlanningAlertsService],
})
export class PlanningModule {}
