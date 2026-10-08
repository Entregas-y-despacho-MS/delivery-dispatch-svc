import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Dispatch } from './entities/dispatch.entity.js';
import { DispatchesService } from './services/dispatches.service.js';
import { DispatchesController } from './controllers/dispatches.controller.js';
import { DispatchType } from '../dispatch-types/entities/dispatch-type.entity.js';
import { DispatchStatus } from '../dispatch-statuses/entities/dispatch-status.entity.js';
import { ServiceLevel } from '../../catalog/service-levels/entities/service-level.entity.js';
import { RouteBatch } from '../route-batches/entities/route-batch.entity.js';
import { Vehicle } from '../../fleet/vehicles/entities/vehicle.entity.js';
import { VehicleStatus } from '../../fleet/vehicle-statuses/entities/vehicle-status.entity.js';

// autoLoadEntities only registers an entity's TypeORM metadata once it's part of SOME
// forFeature() call — Dispatch's own @ManyToOne relations (directly or transitively via
// RouteBatch -> Vehicle) need every one of these registered too, or DataSource.initialize()
// fails with "Entity metadata for Dispatch#dispatchType was not found" at boot. None of these
// need their own service/controller yet — this is purely registration so Dispatch resolves.
// DeliveryZone isn't listed here — already registered by DeliveryZonesModule.
@Module({
    imports: [
        TypeOrmModule.forFeature([Dispatch, DispatchType, DispatchStatus, ServiceLevel, RouteBatch, Vehicle, VehicleStatus]),
    ],
    controllers: [DispatchesController],
    providers: [DispatchesService],
    exports:   [DispatchesService],
})
export class DispatchesModule {}
