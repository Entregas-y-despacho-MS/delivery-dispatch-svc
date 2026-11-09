import { Module } from '@nestjs/common';
import { RouteBatchClosingModule } from '../../../app/route-batch-closing/route-batch-closing.module.js';
import { DispatchEventsModule } from '../../dispatch/dispatch-events/dispatch-events.module.js';
import { DispatchIncidentsModule } from '../../dispatch/dispatch-incidents/dispatch-incidents.module.js';
import { DispatchStatusPublicationModule } from '../../dispatch/dispatch-status-publication/dispatch-status-publication.module.js';
import { WarehouseReceiptConsumer } from './services/warehouse-receipt-consumer.service.js';
import { WarehouseReceiptIntakeService } from './services/warehouse-receipt-intake.service.js';

/**
 * ST-240.2 (8.8 recepción entrante). Standalone module, like `RmaPickupIntakeModule`: a warehouse
 * receipt is not a sales-order dispatch, so it shares none of the Marketplace/Inventory shipment
 * infrastructure (ST-72.x). `InboundMessageTransaction` comes from the global `InboundMessagesModule`
 * (ST-72.4), already imported by `AppModule`.
 */
@Module({
    imports:   [DispatchEventsModule, DispatchIncidentsModule, DispatchStatusPublicationModule, RouteBatchClosingModule],
    providers: [WarehouseReceiptIntakeService, WarehouseReceiptConsumer],
})
export class WarehouseReceiptIntakeModule {}
