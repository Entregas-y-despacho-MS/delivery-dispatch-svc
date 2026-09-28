import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VehicleIncidentType } from './entities/vehicle-incident-type.entity.js';
import { VehicleIncidentTypesService } from './services/vehicle-incident-types.service.js';
import { VehicleIncidentTypesController } from './controllers/vehicle-incident-types.controller.js';

@Module({
    imports:     [TypeOrmModule.forFeature([VehicleIncidentType])],
    controllers: [VehicleIncidentTypesController],
    providers:   [VehicleIncidentTypesService],
    exports:     [VehicleIncidentTypesService],
})
export class VehicleIncidentTypesModule {}
