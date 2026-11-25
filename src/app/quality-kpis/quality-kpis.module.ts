import { Module } from '@nestjs/common';
import { QualityKpisController } from './controllers/quality-kpis.controller.js';
import { DeliveryPromiseModule } from '../delivery-promise/delivery-promise.module.js';
import { QualityRepository } from './repositories/quality.repository.js';
import { QualityKpisService } from './services/quality-kpis.service.js';

/**
 * ST-300.1 and ST-300.2 (ES-300, Dashboard 4): the calculation of the quality indicators and the endpoint that serves them
 * (`GET /reports/quality`). Read-only, no table, no cache.
 */
@Module({
    imports: [DeliveryPromiseModule],
    controllers: [QualityKpisController],
    providers: [QualityRepository, QualityKpisService],
    exports: [QualityKpisService],
})
export class QualityKpisModule {}
