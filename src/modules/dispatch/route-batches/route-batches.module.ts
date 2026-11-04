import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RouteBatch } from './entities/route-batch.entity.js';
import { RouteBatchEvent } from './entities/route-batch-event.entity.js';
import { RouteBatchesController } from './controllers/route-batches.controller.js';
import { RouteBatchReviewerListener } from './services/route-batch-reviewer.listener.js';
import { RouteBatchReviewerService } from './services/route-batch-reviewer.service.js';
import { RouteCapacityService } from './services/route-capacity.service.js';
import { RouteBatchPromiseApprovalService } from './services/route-batch-promise-approval.service.js';
import { RouteBatchFinalApprovalService } from './services/route-batch-final-approval.service.js';
import { RouteBatchResourcesService } from './services/route-batch-resources.service.js';
import { RouteBatchQueryService } from './services/route-batch-query.service.js';
import { RouteBatchStartService } from './services/route-batch-start.service.js';
import { RouteBatchCotejoPhotoService } from './services/route-batch-cotejo-photo.service.js';
import { RouteBatchReviewerSweepTask } from './route-batch-reviewer-sweep.task.js';
import { RouteBatchAcceptService } from './services/route-batch-accept.service.js';
import { OutboundMessagesModule } from '../../messaging/outbound-messages/outbound-messages.module.js';
import { PromiseFirmingModule } from '../../../app/promise-firming/promise-firming.module.js';

// Reviewer assignment (ST-50.4, D-42). The batch planner (ST-50.2) calls RouteBatchReviewerService.assignReviewer.
@Module({
  imports: [TypeOrmModule.forFeature([RouteBatch, RouteBatchEvent]), OutboundMessagesModule, PromiseFirmingModule],
  controllers: [RouteBatchesController],
  providers: [
    RouteBatchReviewerService,
    RouteBatchReviewerListener,
    RouteBatchReviewerSweepTask,
    RouteCapacityService,
    RouteBatchPromiseApprovalService,
    RouteBatchFinalApprovalService,
    RouteBatchResourcesService,
    RouteBatchQueryService,
    RouteBatchStartService,
    RouteBatchCotejoPhotoService,
    RouteBatchAcceptService,
  ],
  exports: [RouteBatchReviewerService, RouteCapacityService, RouteBatchResourcesService],
})
export class RouteBatchesModule {}
