import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PendingShipment } from './entities/pending-shipment.entity.js';
import { PendingShipmentStore } from './ports/pending-shipment.store.js';
import { TypeOrmPendingShipmentStore } from './repositories/typeorm-pending-shipment.store.js';
import { ShipmentOrderRepository } from './repositories/shipment-order.repository.js';
import { SalesOrderSyncModule } from '../sales-order-sync/sales-order-sync.module.js';

@Module({
    imports: [TypeOrmModule.forFeature([PendingShipment]), SalesOrderSyncModule],
    providers: [
        TypeOrmPendingShipmentStore,
        { provide: PendingShipmentStore, useExisting: TypeOrmPendingShipmentStore },
        ShipmentOrderRepository,
    ],
    exports: [PendingShipmentStore, ShipmentOrderRepository],
})
export class ShipmentIntakeModule {}
