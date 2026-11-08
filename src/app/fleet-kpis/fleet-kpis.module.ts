import { Module } from '@nestjs/common';
import { SlaReportModule } from '../sla-report/sla-report.module.js';
import { FleetKpisController } from './controllers/fleet-kpis.controller.js';
import { FleetKpisService } from './services/fleet-kpis.service.js';

@Module({
    imports: [SlaReportModule],
    controllers: [FleetKpisController],
    providers: [FleetKpisService],
})
export class FleetKpisModule {}
