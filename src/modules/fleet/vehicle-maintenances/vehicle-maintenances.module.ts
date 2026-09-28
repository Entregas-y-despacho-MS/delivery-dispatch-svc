import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VehicleMaintenance } from './entities/vehicle-maintenance.entity.js';
import { VehicleMaintenancesService } from './services/vehicle-maintenances.service.js';
import { VehicleMaintenancesController } from './controllers/vehicle-maintenances.controller.js';
import { VehiclesModule } from '../vehicles/vehicles.module.js';
import { VehicleIncidentTypesModule } from '../vehicle-incident-types/vehicle-incident-types.module.js';

@Module({
    imports: [
        TypeOrmModule.forFeature([VehicleMaintenance]),
        VehiclesModule,
        VehicleIncidentTypesModule,
    ],
    controllers: [VehicleMaintenancesController],
    providers:   [VehicleMaintenancesService],
})
export class VehicleMaintenancesModule {}
