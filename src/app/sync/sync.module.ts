import { Module } from '@nestjs/common';
import { SyncController } from './controllers/sync.controller.js';
import { SyncService } from './services/sync.service.js';
import { DispatchEventsModule } from '../../modules/dispatch/dispatch-events/dispatch-events.module.js';
import { DispatchIncidentsModule } from '../../modules/dispatch/dispatch-incidents/dispatch-incidents.module.js';
import { DeliveryEvidencesModule } from '../../modules/dispatch/delivery-evidences/delivery-evidences.module.js';
import { DispatchesModule } from '../../modules/dispatch/dispatches/dispatches.module.js';

// No own table — orchestrates across dispatch-events/dispatch-incidents/delivery-evidences/
// dispatches (RF-U13). Same shape as app/auth: "system logic", not a domain CRUD module.
@Module({
    imports: [
        DispatchEventsModule,
        DispatchIncidentsModule,
        DeliveryEvidencesModule,
        DispatchesModule,
    ],
    controllers: [SyncController],
    providers:   [SyncService],
})
export class SyncModule {}
