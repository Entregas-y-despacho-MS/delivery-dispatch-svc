import { Module } from '@nestjs/common';
import { DeliveryPromiseModule } from '../delivery-promise/delivery-promise.module.js';
import { QualityRepository } from './repositories/quality.repository.js';
import { QualityKpisService } from './services/quality-kpis.service.js';

/**
 * ST-300.1 (ES-300, Dashboard 4): the calculation of the quality indicators. Read-only, no table, no cache. It has no controller yet:
 * the endpoint, its roles and the Swagger DTOs are the next subtask of the story, which injects `QualityKpisService`.
 */
@Module({
    imports: [DeliveryPromiseModule],
    providers: [QualityRepository, QualityKpisService],
    exports: [QualityKpisService],
})
export class QualityKpisModule {}
