import { Module } from '@nestjs/common';
import { PlanningModule } from '../planning/planning.module.js';
import { BatchRevalidationService } from './services/batch-revalidation.service.js';
import { CutoffBatchesRepository } from './services/cutoff-batches.repository.js';
import { CutoffMatricesService } from './services/cutoff-matrices.service.js';
import { RouteCutoffWriterService } from './services/route-cutoff-writer.service.js';
import { RouteCutoffService } from './services/route-cutoff.service.js';
import { RouteCutoffTask } from './route-cutoff.task.js';

/**
 * D-1 cutoff: reoptimization and validation of the provisional batches (ST-51.3, D-11). OsrmPort,
 * SettingsService and the scheduler registry are global; the task registers itself in `onModuleInit`.
 * `PlanningModule` provides the candidates repository (fleet, warehouses) and the alerts.
 */
@Module({
    imports: [PlanningModule],
    providers: [CutoffBatchesRepository, CutoffMatricesService, BatchRevalidationService, RouteCutoffWriterService, RouteCutoffService, RouteCutoffTask],
    exports: [RouteCutoffService, BatchRevalidationService],
})
export class RouteCutoffModule {}
