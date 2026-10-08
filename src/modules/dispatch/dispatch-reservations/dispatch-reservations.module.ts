import { Module } from '@nestjs/common';
import { DispatchReservationsService } from './services/dispatch-reservations.service.js';
import { DispatchReservationsController } from './controllers/dispatch-reservations.controller.js';

// SettingsService comes from the @Global() SettingsModule; the queries go through the DataSource.
@Module({
    controllers: [DispatchReservationsController],
    providers:   [DispatchReservationsService],
    exports:     [DispatchReservationsService],
})
export class DispatchReservationsModule {}
