import { Module } from '@nestjs/common';
import { RouteBatchesModule } from '../../modules/dispatch/route-batches/route-batches.module.js';
import { LotPlanner } from './ports/lot-planner.js';
import { InsertionLotPlanner } from './services/insertion-lot-planner.js';
import { PlanCandidatesRepository } from './services/plan-candidates.repository.js';
import { PlanWriterService } from './services/plan-writer.service.js';

/**
 * Provisional batch generator (ST-50.2, D-41). OsrmPort (global) and DataSource come from the app.
 * The scheduler registration and the generation service are added by the later stages of the task.
 */
@Module({
    imports: [RouteBatchesModule],
    providers: [
        PlanCandidatesRepository,
        PlanWriterService,
        InsertionLotPlanner,
        { provide: LotPlanner, useExisting: InsertionLotPlanner },
    ],
    exports: [LotPlanner, PlanCandidatesRepository, PlanWriterService],
})
export class PlanningModule {}
