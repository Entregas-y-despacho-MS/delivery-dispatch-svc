import { Module } from '@nestjs/common';
import { DispatchEventsModule } from '../../modules/dispatch/dispatch-events/dispatch-events.module.js';
import { DeliveryEvidencesModule } from '../../modules/dispatch/delivery-evidences/delivery-evidences.module.js';
import { DispatchIncidentsModule } from '../../modules/dispatch/dispatch-incidents/dispatch-incidents.module.js';
import { DispatchStatusPublicationModule } from '../../modules/dispatch/dispatch-status-publication/dispatch-status-publication.module.js';
import { OutboundMessagesModule } from '../../modules/messaging/outbound-messages/outbound-messages.module.js';
import { SupplierPickupController } from './supplier-pickup.controller.js';
import { SupplierPickupService } from './supplier-pickup.service.js';

/** ST-239.2 (8.6, ERP-06): recogida en proveedor y llegada al almacén destino. */
@Module({
    imports:     [DispatchEventsModule, DeliveryEvidencesModule, DispatchIncidentsModule, DispatchStatusPublicationModule, OutboundMessagesModule],
    controllers: [SupplierPickupController],
    providers:   [SupplierPickupService],
})
export class SupplierPickupModule {}
