import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PendingSalesOrder } from './entities/pending-sales-order.entity.js';
import { PendingSalesOrderStore } from './ports/pending-sales-order.store.js';
import { MarketplaceOrderRepository } from './repositories/marketplace-order.repository.js';
import { TypeOrmPendingSalesOrderStore } from './repositories/typeorm-pending-sales-order.store.js';

/**
 * Marketplace side of the sales-order intake (ST-72.2).
 *
 * `MarketplaceOrderRepository` also needs `OrderSyncStatePort` and, in the next stages, `SalesOrderLock`.
 * Their real adapters come with the migration 014 and ST-72.4 (ST-72.1 / ST-72.4, Sergio), so this
 * module is not imported by `AppModule` yet: it is wired together with the consumer once those exist.
 */
@Module({
    imports:   [TypeOrmModule.forFeature([PendingSalesOrder])],
    providers: [
        { provide: PendingSalesOrderStore, useClass: TypeOrmPendingSalesOrderStore },
        MarketplaceOrderRepository,
    ],
    exports:   [MarketplaceOrderRepository],
})
export class SalesOrderIntakeModule {}
