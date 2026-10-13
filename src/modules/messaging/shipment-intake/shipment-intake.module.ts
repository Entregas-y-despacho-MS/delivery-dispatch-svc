import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Warehouse } from '../../catalog/warehouses/entities/warehouse.entity.js';
import { PendingShipment } from './entities/pending-shipment.entity.js';
import { PendingShipmentStore } from './ports/pending-shipment.store.js';
import { WarehouseCodeLookup } from './ports/warehouse-code.lookup.js';
import { TypeOrmPendingShipmentStore } from './repositories/typeorm-pending-shipment.store.js';
import { TypeOrmWarehouseCodeLookup } from './repositories/typeorm-warehouse-code.lookup.js';
import { ShipmentOrderRepository } from './repositories/shipment-order.repository.js';
import { SalesOrderSyncModule } from '../sales-order-sync/sales-order-sync.module.js';
import { ShipmentBlocksReader } from '../sales-order-intake/ports/shipment-blocks.reader.js';
import { TypeOrmShipmentBlocksReader } from './repositories/typeorm-shipment-blocks.reader.js';

@Module({
    imports: [TypeOrmModule.forFeature([PendingShipment, Warehouse]), SalesOrderSyncModule],
    providers: [
        TypeOrmPendingShipmentStore,
        { provide: PendingShipmentStore, useExisting: TypeOrmPendingShipmentStore },
        TypeOrmWarehouseCodeLookup,
        { provide: WarehouseCodeLookup, useExisting: TypeOrmWarehouseCodeLookup },
        ShipmentOrderRepository,
        TypeOrmShipmentBlocksReader,
        { provide: ShipmentBlocksReader, useExisting: TypeOrmShipmentBlocksReader },
    ],
    exports: [PendingShipmentStore, WarehouseCodeLookup, ShipmentOrderRepository, ShipmentBlocksReader],
})
export class ShipmentIntakeModule {}
