import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PendingShipment } from './entities/pending-shipment.entity.js';
import { PendingShipmentStore } from './ports/pending-shipment.store.js';
import { TypeOrmPendingShipmentStore } from './repositories/typeorm-pending-shipment.store.js';

@Module({
    imports: [TypeOrmModule.forFeature([PendingShipment])],
    providers: [TypeOrmPendingShipmentStore, { provide: PendingShipmentStore, useExisting: TypeOrmPendingShipmentStore }],
    exports: [PendingShipmentStore],
})
export class ShipmentIntakeModule {}
