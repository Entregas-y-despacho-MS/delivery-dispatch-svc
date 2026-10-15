import { Module } from '@nestjs/common';
import { OutboundMessagesModule } from '../../messaging/outbound-messages/outbound-messages.module.js';
import { PickupSchedulingController } from './controllers/pickup-scheduling.controller.js';
import { PickupSchedulingService } from './services/pickup-scheduling.service.js';

// SettingsService is @Global(); the dispatch tables are read and written with the transaction's manager.
@Module({
    imports:     [OutboundMessagesModule],
    controllers: [PickupSchedulingController],
    providers:   [PickupSchedulingService],
    exports:     [PickupSchedulingService],
})
export class PickupSchedulingModule {}
