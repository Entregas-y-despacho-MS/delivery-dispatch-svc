import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Vehicle } from './entities/vehicle.entity.js';
import { VehicleStatus } from '../vehicle-statuses/entities/vehicle-status.entity.js';
import { VehiclesService } from './services/vehicles.service.js';
import { VehiclesController } from './controllers/vehicles.controller.js';

@Module({
    imports:     [TypeOrmModule.forFeature([Vehicle, VehicleStatus])],
    controllers: [VehiclesController],
    providers:   [VehiclesService],
    exports:     [VehiclesService],
})
export class VehiclesModule {}
