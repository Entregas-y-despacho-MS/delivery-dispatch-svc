import { Module } from '@nestjs/common';
import { DispatchEventsModule } from '../../modules/dispatch/dispatch-events/dispatch-events.module.js';
import { DeliveryEvidencesModule } from '../../modules/dispatch/delivery-evidences/delivery-evidences.module.js';
import { DispatchesModule } from '../../modules/dispatch/dispatches/dispatches.module.js';
import { DispatchStatusPublicationModule } from '../../modules/dispatch/dispatch-status-publication/dispatch-status-publication.module.js';
import { DispatchStatusController } from './controllers/dispatch-status.controller.js';
import { DispatchStatusService } from './services/dispatch-status.service.js';

@Module({
    imports: [DispatchesModule, DispatchEventsModule, DeliveryEvidencesModule, DispatchStatusPublicationModule],
    controllers: [DispatchStatusController],
    providers: [DispatchStatusService],
})
export class DispatchStatusModule {}
