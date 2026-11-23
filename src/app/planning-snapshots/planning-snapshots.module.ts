import { Module } from '@nestjs/common';
import { PlanningCutoffsModule } from '../../modules/dispatch/planning-cutoffs/planning-cutoffs.module.js';
import { PlanningSnapshotsController } from './controllers/planning-snapshots.controller.js';
import { PlanningSnapshotsRepository } from './repositories/planning-snapshots.repository.js';
import { CutoffSnapshotService } from './services/cutoff-snapshot.service.js';
import { PlanningSnapshotsService } from './services/planning-snapshots.service.js';

/**
 * ST-302.2 (ES-302): the planning universe of each cutoff and the frozen route manifests. `CutoffSnapshotService` writes the
 * universe when the cutoff runs; `PlanningSnapshotsService` reads coverage and completion over it. The read side is
 * not cached: it reads frozen rows that never change.
 */
@Module({
    imports: [PlanningCutoffsModule],
    controllers: [PlanningSnapshotsController],
    providers: [CutoffSnapshotService, PlanningSnapshotsRepository, PlanningSnapshotsService],
    exports: [CutoffSnapshotService],
})
export class PlanningSnapshotsModule {}
