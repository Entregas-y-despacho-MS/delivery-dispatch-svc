import { Module } from '@nestjs/common';
import { SlaReportModule } from '../sla-report/sla-report.module.js';
import { FleetReportsController } from './controllers/fleet-reports.controller.js';
import { FleetAvailabilityRepository } from './repositories/fleet-availability.repository.js';
import { FleetMaintenanceReportRepository } from './repositories/fleet-maintenance-report.repository.js';
import { FleetAvailabilityService } from './services/fleet-availability.service.js';
import { FleetReportsService } from './services/fleet-reports.service.js';

@Module({
    imports: [SlaReportModule],
    controllers: [FleetReportsController],
    providers: [FleetMaintenanceReportRepository, FleetReportsService, FleetAvailabilityRepository, FleetAvailabilityService],
})
export class FleetReportsModule {}
