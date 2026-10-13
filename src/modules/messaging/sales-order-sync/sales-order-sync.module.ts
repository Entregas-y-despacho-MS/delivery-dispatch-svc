import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SalesOrderSyncState } from './entities/sales-order-sync-state.entity.js';
import { OrderSyncStatePort } from './ports/order-sync-state.port.js';
import { TypeOrmOrderSyncStateAdapter } from './repositories/typeorm-order-sync-state.adapter.js';

@Module({
    imports: [TypeOrmModule.forFeature([SalesOrderSyncState])],
    providers: [TypeOrmOrderSyncStateAdapter, { provide: OrderSyncStatePort, useExisting: TypeOrmOrderSyncStateAdapter }],
    exports: [OrderSyncStatePort],
})
export class SalesOrderSyncModule {}
