import { Module } from '@nestjs/common';
import { PublicTrackingController } from './controllers/public-tracking.controller.js';
import { PublicTrackingService } from './services/public-tracking.service.js';

/**
 * The customer's public page (ST-224.1, RF-U14, RF-U21). No table of its own: it works on dispatches.
 * `SettingsService` is global.
 */
@Module({
    controllers: [PublicTrackingController],
    providers: [PublicTrackingService],
    exports: [PublicTrackingService],
})
export class PublicTrackingModule {}
