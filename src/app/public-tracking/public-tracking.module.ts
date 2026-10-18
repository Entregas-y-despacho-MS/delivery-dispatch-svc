import { Module } from '@nestjs/common';
import { PlanningModule } from '../planning/planning.module.js';
import { PromiseFirmingModule } from '../promise-firming/promise-firming.module.js';
import { PublicTrackingController } from './controllers/public-tracking.controller.js';
import { CustomerResponseService } from './services/customer-response.service.js';
import { PublicTrackingService } from './services/public-tracking.service.js';
import { SlotOfferService } from './services/slot-offer.service.js';
import { VerificationCodeService } from './services/verification-code.service.js';

/**
 * The customer's public page (ST-224.1, RF-U14, RF-U21). No table of its own: it works on dispatches.
 * `SettingsService` is global.
 */
@Module({
    imports: [PlanningModule, PromiseFirmingModule],
    controllers: [PublicTrackingController],
    providers: [PublicTrackingService, VerificationCodeService, CustomerResponseService, SlotOfferService],
    exports: [PublicTrackingService, VerificationCodeService, CustomerResponseService, SlotOfferService],
})
export class PublicTrackingModule {}
