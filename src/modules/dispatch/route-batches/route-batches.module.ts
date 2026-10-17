import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RouteBatch } from './entities/route-batch.entity.js';
import { RouteBatchEvent } from './entities/route-batch-event.entity.js';
import { RouteBatchesController } from './controllers/route-batches.controller.js';
import { RouteBatchReviewerListener } from './services/route-batch-reviewer.listener.js';
import { RouteBatchReviewerService } from './services/route-batch-reviewer.service.js';
import { RouteCapacityService } from './services/route-capacity.service.js';
import { RouteBatchVehicleService } from './services/route-batch-vehicle.service.js';
import { RouteBatchPromiseApprovalService } from './services/route-batch-promise-approval.service.js';
import { RouteBatchFinalApprovalService } from './services/route-batch-final-approval.service.js';
import { RouteBatchQueryService } from './services/route-batch-query.service.js';

// Reviewer assignment (ST-50.4, D-42). The batch planner (ST-50.2) calls RouteBatchReviewerService.assignReviewer.
@Module({
  imports: [TypeOrmModule.forFeature([RouteBatch, RouteBatchEvent])],
  controllers: [RouteBatchesController],
  providers: [
    RouteBatchReviewerService,
    RouteBatchReviewerListener,
    RouteCapacityService,
    RouteBatchVehicleService,
    RouteBatchPromiseApprovalService,
    RouteBatchFinalApprovalService,
    RouteBatchQueryService,
  ],
  exports: [RouteBatchReviewerService],
})
export class RouteBatchesModule {}
