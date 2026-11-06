import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Setting } from './entities/setting.entity.js';
import { SettingsService } from './services/settings.service.js';
import { SettingsController } from './controllers/settings.controller.js';
import { AlertThresholdsController } from './controllers/alert-thresholds.controller.js';
import { AlertThresholdsService } from './services/alert-thresholds.service.js';

// @Global() — SettingsService is read constantly from other modules (auth, and future ones:
// delivery windows, SLA thresholds). Same reasoning as MailerModule/AppConfigModule.
@Global()
@Module({
    imports:     [TypeOrmModule.forFeature([Setting])],
    // AlertThresholdsController first: `PUT /settings/:key` would otherwise match `alert-thresholds`.
    controllers: [AlertThresholdsController, SettingsController],
    providers:   [SettingsService, AlertThresholdsService],
    exports:     [SettingsService],
})
export class SettingsModule {}
