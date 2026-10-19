import { Module } from '@nestjs/common';
import { DriverMetricsController } from './controllers/driver-metrics.controller.js';
import { DriverMetricsListener } from './driver-metrics.listener.js';
import { DriverMetricsRepository } from './repositories/driver-metrics.repository.js';
import { DriverMetricsService } from './services/driver-metrics.service.js';

@Module({
    controllers: [DriverMetricsController],
    providers: [DriverMetricsRepository, DriverMetricsService, DriverMetricsListener],
    // Whoever starts writing `dispatch_ratings` must call `DriverMetricsService.invalidate(driverId)` afterwards:
    // a new rating changes `rating`/`ratingsCount` and the delivery listener does not see it.
    exports: [DriverMetricsService],
})
export class DriverMetricsModule {}
