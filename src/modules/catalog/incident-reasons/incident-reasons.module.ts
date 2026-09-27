import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IncidentReason } from './entities/incident-reason.entity.js';
import { IncidentReasonsService } from './services/incident-reasons.service.js';
import { IncidentReasonsController } from './controllers/incident-reasons.controller.js';

@Module({
    imports:     [TypeOrmModule.forFeature([IncidentReason])],
    controllers: [IncidentReasonsController],
    providers:   [IncidentReasonsService],
    exports:     [IncidentReasonsService],
})
export class IncidentReasonsModule {}
