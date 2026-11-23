import { Module } from '@nestjs/common';
import { PlanningCutoffsModule } from '../../modules/dispatch/planning-cutoffs/planning-cutoffs.module.js';
import { CutoffSnapshotService } from './services/cutoff-snapshot.service.js';

/** ST-302.2 (ES-302): freezes the planning universe of each cutoff. The reading endpoints arrive with the query stage. */
@Module({
    imports: [PlanningCutoffsModule],
    providers: [CutoffSnapshotService],
    exports: [CutoffSnapshotService],
})
export class PlanningSnapshotsModule {}
