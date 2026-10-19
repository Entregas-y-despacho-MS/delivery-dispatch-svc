import { Module } from '@nestjs/common';
import { DriverMetricsController } from './controllers/driver-metrics.controller.js';
import { DriverMetricsListener } from './driver-metrics.listener.js';
import { DriverMetricsRepository } from './repositories/driver-metrics.repository.js';
import { DriverMetricsService } from './services/driver-metrics.service.js';

@Module({
    controllers: [DriverMetricsController],
    providers: [DriverMetricsRepository, DriverMetricsService, DriverMetricsListener],
})
export class DriverMetricsModule {}
