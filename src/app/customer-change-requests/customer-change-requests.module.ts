import { Module } from '@nestjs/common';
import { CustomerChangeRequestsController } from './controllers/customer-change-requests.controller.js';
import { CustomerChangeRequestsService } from './services/customer-change-requests.service.js';

/**
 * The coordinator's tray of customer change requests (ST-224.1 extension, ES-227). No table of its own: it reads
 * `dispatches` and their `dispatch_events`. The route is under `/dispatches/change-requests`, next to the kanban.
 */
@Module({
    controllers: [CustomerChangeRequestsController],
    providers: [CustomerChangeRequestsService],
    exports: [CustomerChangeRequestsService],
})
export class CustomerChangeRequestsModule {}
