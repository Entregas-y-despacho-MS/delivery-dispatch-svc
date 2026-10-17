import { Module } from '@nestjs/common';
import { RouteBatchesModule } from '../../modules/dispatch/route-batches/route-batches.module.js';
import { RouteCutoffModule } from '../route-cutoff/route-cutoff.module.js';
import { RouteBatchCorrectionController } from './controllers/route-batch-correction.controller.js';
import { RouteBatchCorrectionService } from './services/route-batch-correction.service.js';

/**
 * Correction of the driver and the vehicle of a route batch, and the validation that follows (ST-51.6).
 * It lives apart from `RouteBatchesModule` because it needs the cutoff, and `PlanningModule` (which the cutoff
 * imports) already imports `RouteBatchesModule`: importing the cutoff from there would be a cycle.
 */
@Module({
    imports: [RouteBatchesModule, RouteCutoffModule],
    controllers: [RouteBatchCorrectionController],
    providers: [RouteBatchCorrectionService],
})
export class RouteBatchCorrectionModule {}
