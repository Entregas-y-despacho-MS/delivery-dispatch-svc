import { Module } from '@nestjs/common';
import { DeliveryPromiseController } from './controllers/delivery-promise.controller.js';
import { AttemptsRepository } from './repositories/attempts.repository.js';
import { BacklogRepository } from './repositories/backlog.repository.js';
import { OtdRepository } from './repositories/otd.repository.js';
import { DeliveryBacklogService } from './services/delivery-backlog.service.js';
import { FirstAttemptService } from './services/first-attempt.service.js';
import { OtdReportService } from './services/otd-report.service.js';

/** ST-301.1 and ST-301.3 (ES-301): OTD by cohort of promise, volume of the backlog and delivery at the first attempt. Read-only: it owns no table and has no cache. */
@Module({
    controllers: [DeliveryPromiseController],
    providers: [OtdRepository, BacklogRepository, AttemptsRepository, FirstAttemptService, OtdReportService, DeliveryBacklogService],
    // The attempts are read by the quality indicators of ES-300 (ST-300.1) too.
    exports: [AttemptsRepository],
})
export class DeliveryPromiseModule {}
