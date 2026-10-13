import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DispatchesModule } from '../../dispatch/dispatches/dispatches.module.js';
import { SalesOrderSyncModule } from '../sales-order-sync/sales-order-sync.module.js';
import { ShipmentIntakeModule } from '../shipment-intake/shipment-intake.module.js';
import { ShipmentConsolidator } from '../shipment-intake/ports/shipment-consolidator.port.js';
import { ShipmentOrderConsumer } from '../shipment-intake/services/shipment-order-consumer.service.js';
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
 * The Marketplace and Inventory consumers share the same order lock, consolidator and rules for
 * existing dispatches. The inbound transaction port comes from global InboundMessagesModule
 * (ST-72.4); this module is activated after that PR is integrated.
 */
@Module({
    imports:   [TypeOrmModule.forFeature([PendingSalesOrder]), SalesOrderSyncModule, ShipmentIntakeModule, DispatchesModule],
    providers: [
        { provide: PendingSalesOrderStore, useClass: TypeOrmPendingSalesOrderStore },
        { provide: ConsolidationRecord, useClass: TypeOrmConsolidationRecord },
        { provide: ExistingDispatchChanges, useClass: TypeOrmExistingDispatchChanges },
        MarketplaceOrderRepository,
        OrderConsolidator,
        { provide: ShipmentConsolidator, useExisting: OrderConsolidator },
        DispatchChangeEvents,
        MarketplaceOrderConsumer,
        ShipmentOrderConsumer,
    ],
    exports:   [MarketplaceOrderRepository, OrderConsolidator, ExistingDispatchChanges, DispatchChangeEvents],
})
export class SalesOrderIntakeModule {}
