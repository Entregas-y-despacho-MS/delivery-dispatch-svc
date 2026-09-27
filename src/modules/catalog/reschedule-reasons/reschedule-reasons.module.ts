import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RescheduleReason } from './entities/reschedule-reason.entity.js';
import { RescheduleReasonsService } from './services/reschedule-reasons.service.js';
import { RescheduleReasonsController } from './controllers/reschedule-reasons.controller.js';

@Module({
    imports:     [TypeOrmModule.forFeature([RescheduleReason])],
    controllers: [RescheduleReasonsController],
    providers:   [RescheduleReasonsService],
    exports:     [RescheduleReasonsService],
})
export class RescheduleReasonsModule {}
