import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DispatchIncident } from './entities/dispatch-incident.entity.js';
import { DispatchIncidentsService } from './services/dispatch-incidents.service.js';
import { IncidentReason } from '../../catalog/incident-reasons/entities/incident-reason.entity.js';

// IncidentReason needs to be registered too — DispatchIncident.incidentReason (@ManyToOne)
// otherwise fails TypeORM's metadata build (same reasoning as DispatchesModule).
@Module({
    imports:   [TypeOrmModule.forFeature([DispatchIncident, IncidentReason])],
    providers: [DispatchIncidentsService],
    exports:   [DispatchIncidentsService],
})
export class DispatchIncidentsModule {}
