import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PendingSalesOrder } from './entities/pending-sales-order.entity.js';
import { PendingSalesOrderStore } from './ports/pending-sales-order.store.js';
import { MarketplaceOrderRepository } from './repositories/marketplace-order.repository.js';
import { TypeOrmPendingSalesOrderStore } from './repositories/typeorm-pending-sales-order.store.js';
import { MarketplaceOrderConsumer } from './services/marketplace-order-consumer.service.js';

/**
 * Marketplace side of the sales-order intake (ST-72.2).
 *
 * It needs three providers that other subtasks bring: `OrderSyncStatePort` (the real adapter comes
 * with the migration 014 and ST-72.1) and `InboundMessageTransaction` (the TypeORM adapter comes
 * with the follow-up of ST-72.0 / ST-72.4); `MessageBus` is already global. Until they exist this
 * module is not imported by `AppModule`: wiring it earlier would stop the application at startup.
 */
@Module({
    imports:   [TypeOrmModule.forFeature([PendingSalesOrder])],
    providers: [
        { provide: PendingSalesOrderStore, useClass: TypeOrmPendingSalesOrderStore },
        MarketplaceOrderRepository,
        MarketplaceOrderConsumer,
    ],
    exports:   [MarketplaceOrderRepository],
})
export class SalesOrderIntakeModule {}
