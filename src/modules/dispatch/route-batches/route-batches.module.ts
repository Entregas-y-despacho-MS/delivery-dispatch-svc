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
import { RouteBatchCotejoExclusionsService } from './services/route-batch-cotejo-exclusions.service.js';
import { RouteBatchCotejoResolutionService } from './services/route-batch-cotejo-resolution.service.js';
import { CotejoResolutionController } from './controllers/cotejo-resolution.controller.js';
import { PlanningAlertsService } from '../../../app/planning/services/planning-alerts.service.js';
import { OutboundMessagesModule } from '../../messaging/outbound-messages/outbound-messages.module.js';
import { PromiseFirmingModule } from '../../../app/promise-firming/promise-firming.module.js';
import { DispatchRescheduleModule } from '../../../app/dispatch-reschedule/dispatch-reschedule.module.js';
import { RouteBatchReassignmentService } from './services/route-batch-reassignment.service.js';
import { ReassignmentTargetsService } from './services/reassignment-targets.service.js';

// Reviewer assignment (ST-50.4, D-42). The batch planner (ST-50.2) calls RouteBatchReviewerService.assignReviewer.
@Module({
  imports: [TypeOrmModule.forFeature([RouteBatch, RouteBatchEvent]), OutboundMessagesModule, PromiseFirmingModule, DispatchRescheduleModule],
  controllers: [RouteBatchesController, CotejoResolutionController],
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
    RouteBatchCotejoExclusionsService,
    RouteBatchCotejoResolutionService,
    // PlanningModule imports this module, so it cannot be imported back (cycle). The service has no state of its
    // own (DataSource + the global event emitter), so this module gets its own instance for the cotejo alert.
    PlanningAlertsService,
    RouteBatchReassignmentService,
    ReassignmentTargetsService,
  ],
  exports: [RouteBatchReviewerService, RouteCapacityService, RouteBatchResourcesService],
})
export class RouteBatchesModule {}
