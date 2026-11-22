import { Module } from '@nestjs/common';
import { DeliveryPromiseController } from './controllers/delivery-promise.controller.js';
import { BacklogRepository } from './repositories/backlog.repository.js';
import { OtdRepository } from './repositories/otd.repository.js';
import { DeliveryBacklogService } from './services/delivery-backlog.service.js';
import { OtdReportService } from './services/otd-report.service.js';

/** ST-301.1 (ES-301): OTD by cohort of promise and volume of the backlog. Read-only: it owns no table and has no cache. */
@Module({
    controllers: [DeliveryPromiseController],
    providers: [OtdRepository, BacklogRepository, OtdReportService, DeliveryBacklogService],
})
export class DeliveryPromiseModule {}
