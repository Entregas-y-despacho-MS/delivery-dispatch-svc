import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RmaSyncState } from './entities/rma-sync-state.entity.js';
import { RmaSyncStatePort } from './ports/rma-sync-state.port.js';
import { TypeOrmRmaSyncStateAdapter } from './repositories/typeorm-rma-sync-state.adapter.js';
import { PickupOrderService } from './services/pickup-order.service.js';
import { RmaPickupConsumer } from './services/rma-pickup-consumer.service.js';

/**
 * ST-238.1/ST-238.2 (8.7 RMA entrante). Standalone module: unlike `SalesOrderIntakeModule`, it does
 * not share the order lock/consolidator infrastructure of the Marketplace/Inventory shipment flow
 * (ST-72.x) — a recojo de devolución is not a sales-order dispatch. `InboundMessageTransaction`
 * comes from the global `InboundMessagesModule` (ST-72.4), already imported by `AppModule`.
 */
@Module({
    imports:   [TypeOrmModule.forFeature([RmaSyncState])],
    providers: [
        { provide: RmaSyncStatePort, useClass: TypeOrmRmaSyncStateAdapter },
        PickupOrderService,
        RmaPickupConsumer,
    ],
    exports:   [PickupOrderService],
})
export class RmaPickupIntakeModule {}
