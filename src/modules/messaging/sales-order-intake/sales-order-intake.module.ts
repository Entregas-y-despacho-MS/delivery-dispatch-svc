import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PendingSalesOrder } from './entities/pending-sales-order.entity.js';
import { ConsolidationRecord } from './ports/consolidation-record.port.js';
import { ExistingDispatchChanges } from './ports/existing-dispatch-changes.port.js';
import { PendingSalesOrderStore } from './ports/pending-sales-order.store.js';
import { MarketplaceOrderRepository } from './repositories/marketplace-order.repository.js';
import { TypeOrmConsolidationRecord } from './repositories/typeorm-consolidation-record.js';
import { TypeOrmExistingDispatchChanges } from './repositories/typeorm-existing-dispatch-changes.js';
import { TypeOrmPendingSalesOrderStore } from './repositories/typeorm-pending-sales-order.store.js';
import { DispatchChangeEvents } from './services/dispatch-change-events.service.js';
import { MarketplaceOrderConsumer } from './services/marketplace-order-consumer.service.js';
import { OrderConsolidator } from './services/order-consolidator.service.js';

/**
 * Marketplace side of the sales-order intake (ST-72.2).
 *
 * It needs four providers that other subtasks bring, none of which is wired yet:
 * - `OrderSyncStatePort` and `ShipmentBlocksReader`: the Almacén side (ST-72.1, PR #12).
 * - `InboundMessageTransaction`: the TypeORM adapter of the follow-up of ST-72.0 (ST-72.4).
 * - `DispatchGenerator`: the creation of the dispatch (ST-49.1, PR #13).
 * `MessageBus` is already global, and so is `EventEmitter2`. Until they exist this module is not
 * imported by `AppModule`: wiring it earlier would stop the application at startup.
 *
 * `OrderConsolidator` and `ExistingDispatchChanges` are exported because the Almacén consumer
 * calls `tryConsolidate` and the same dispatch rules too (a single copy of them, here).
 */
@Module({
    imports:   [TypeOrmModule.forFeature([PendingSalesOrder])],
    providers: [
        { provide: PendingSalesOrderStore, useClass: TypeOrmPendingSalesOrderStore },
        { provide: ConsolidationRecord, useClass: TypeOrmConsolidationRecord },
        { provide: ExistingDispatchChanges, useClass: TypeOrmExistingDispatchChanges },
        MarketplaceOrderRepository,
        OrderConsolidator,
        DispatchChangeEvents,
        MarketplaceOrderConsumer,
    ],
    exports:   [MarketplaceOrderRepository, OrderConsolidator, ExistingDispatchChanges, DispatchChangeEvents],
})
export class SalesOrderIntakeModule {}
