import { Module } from '@nestjs/common';
import { DispatchHistoryService } from './services/dispatch-history.service.js';
import { DispatchHistoryController } from './controllers/dispatch-history.controller.js';

// Read-only view over dispatches, routes, drivers, vehicles and events: it runs raw SQL through the DataSource.
@Module({
    controllers: [DispatchHistoryController],
    providers:   [DispatchHistoryService],
})
export class DispatchHistoryModule {}
