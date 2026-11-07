import { Module } from '@nestjs/common';
import { DispatchEventsModule } from '../../modules/dispatch/dispatch-events/dispatch-events.module.js';
import { DispatchStatusPublicationModule } from '../../modules/dispatch/dispatch-status-publication/dispatch-status-publication.module.js';
import { RouteBatchClosingModule } from '../route-batch-closing/route-batch-closing.module.js';
import { DispatchRescheduleController } from './controllers/dispatch-reschedule.controller.js';
import { BatchExitService } from './services/batch-exit.service.js';
import { DeliveryAttemptsService } from './services/delivery-attempts.service.js';
import { DispatchCancelService } from './services/dispatch-cancel.service.js';
import { DispatchLockService } from './services/dispatch-lock.service.js';
import { DispatchReturnService } from './services/dispatch-return.service.js';
import { DispatchReschedulingService } from './services/dispatch-rescheduling.service.js';

/**
 * Actions of the coordinator on a delivery that did not go as planned (ES-52): reschedule it (ST-52.2) or return it
 * to the warehouse. No table of its own: it writes `dispatch_reschedules`, `dispatches` and the audit events.
 */
@Module({
    imports: [DispatchEventsModule, DispatchStatusPublicationModule, RouteBatchClosingModule],
    controllers: [DispatchRescheduleController],
    providers: [BatchExitService, DeliveryAttemptsService, DispatchCancelService, DispatchLockService, DispatchReschedulingService, DispatchReturnService],
    exports: [BatchExitService, DeliveryAttemptsService, DispatchCancelService, DispatchLockService],
})
export class DispatchRescheduleModule {}
