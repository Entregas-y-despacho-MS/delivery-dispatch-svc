import { Module } from '@nestjs/common';
import { SlaReportController } from './controllers/sla-report.controller.js';
import { SlaReportRepository } from './repositories/sla-report.repository.js';
import { SlaReportService } from './services/sla-report.service.js';

@Module({
    controllers: [SlaReportController],
    providers: [SlaReportRepository, SlaReportService],
    // ST-61.1 (fleet KPIs) and ST-65.1 (fleet report) reuse `aggregate` for the `driver` grouping, with the same cache.
    exports: [SlaReportService],
})
export class SlaReportModule {}
