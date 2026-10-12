import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DispatchReservationsService } from './services/dispatch-reservations.service.js';
import { DispatchReservationsController } from './controllers/dispatch-reservations.controller.js';
import { DispatchReservation } from './entities/dispatch-reservation.entity.js';

// SettingsService comes from the @Global() SettingsModule; the queries go through the DataSource.
@Module({
    imports: [TypeOrmModule.forFeature([DispatchReservation])],
    controllers: [DispatchReservationsController],
    providers:   [DispatchReservationsService],
    exports:     [DispatchReservationsService],
})
export class DispatchReservationsModule {}
