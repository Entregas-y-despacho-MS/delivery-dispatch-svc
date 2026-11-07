import { Module } from '@nestjs/common';
import { RouteBatchesModule } from '../../modules/dispatch/route-batches/route-batches.module.js';
import { PlanningModule } from '../planning/planning.module.js';
import { PromiseFirmingModule } from '../promise-firming/promise-firming.module.js';
import { DriverMetricsModule } from '../driver-metrics/driver-metrics.module.js';
import { PublicTrackingController } from './controllers/public-tracking.controller.js';
import { CustomerRescheduleService } from './services/customer-reschedule.service.js';
import { CustomerResponseService } from './services/customer-response.service.js';
import { PublicTrackingService } from './services/public-tracking.service.js';
import { SlotOfferService } from './services/slot-offer.service.js';
import { TrackingEtaService } from './services/tracking-eta.service.js';
import { VerificationCodeService } from './services/verification-code.service.js';

/**
 * The customer's public page (ST-224.1, RF-U14, RF-U21). No table of its own: it works on dispatches.
 * `SettingsService` is global.
 */
@Module({
    imports: [PlanningModule, PromiseFirmingModule, RouteBatchesModule, DriverMetricsModule],
    controllers: [PublicTrackingController],
    providers: [PublicTrackingService, TrackingEtaService, VerificationCodeService, CustomerResponseService, SlotOfferService, CustomerRescheduleService],
    exports: [PublicTrackingService, VerificationCodeService, CustomerResponseService, SlotOfferService, CustomerRescheduleService],
})
export class PublicTrackingModule {}
