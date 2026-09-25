import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServiceLevel } from './entities/service-level.entity.js';
import { ServiceLevelsService } from './services/service-levels.service.js';
import { ServiceLevelsController } from './controllers/service-levels.controller.js';
import { DispatchesModule } from '../../dispatch/dispatches/dispatches.module.js';

@Module({
    imports:     [TypeOrmModule.forFeature([ServiceLevel]), DispatchesModule],
    controllers: [ServiceLevelsController],
    providers:   [ServiceLevelsService],
    exports:     [ServiceLevelsService],
})
export class ServiceLevelsModule {}
