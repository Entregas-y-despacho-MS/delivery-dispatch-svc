import { Module } from '@nestjs/common';
import { DeliveryEvidencesModule } from '../../modules/dispatch/delivery-evidences/delivery-evidences.module.js';
import { DispatchEventsModule } from '../../modules/dispatch/dispatch-events/dispatch-events.module.js';
import { DispatchIncidentsModule as DispatchIncidentsDomainModule } from '../../modules/dispatch/dispatch-incidents/dispatch-incidents.module.js';
import { DispatchIncidentsController } from './dispatch-incidents.controller.js';
import { DispatchIncidentsAppService } from './dispatch-incidents.service.js';

@Module({
    imports: [DispatchIncidentsDomainModule, DeliveryEvidencesModule, DispatchEventsModule],
    controllers: [DispatchIncidentsController],
    providers: [DispatchIncidentsAppService],
})
export class DispatchIncidentsAppModule {}
