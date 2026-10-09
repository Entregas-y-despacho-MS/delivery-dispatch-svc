import { Module } from '@nestjs/common';
import { PendingOrdersService } from './services/pending-orders.service.js';
import { PendingOrdersController } from './controllers/pending-orders.controller.js';

// Read-only view over dispatches, packages and reservations: it runs raw SQL through the DataSource.
@Module({
    controllers: [PendingOrdersController],
    providers:   [PendingOrdersService],
})
export class PendingOrdersModule {}
