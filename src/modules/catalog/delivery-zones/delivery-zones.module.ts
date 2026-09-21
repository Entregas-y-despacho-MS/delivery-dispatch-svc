import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeliveryZone } from './entities/delivery-zone.entity.js';
import { DeliveryZonesService } from './services/delivery-zones.service.js';
import { DeliveryZonesController } from './controllers/delivery-zones.controller.js';

@Module({
    imports:     [TypeOrmModule.forFeature([DeliveryZone])],
    controllers: [DeliveryZonesController],
    providers:   [DeliveryZonesService],
    exports:     [DeliveryZonesService],
})
export class DeliveryZonesModule {}
