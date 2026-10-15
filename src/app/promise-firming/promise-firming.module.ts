import { Module } from '@nestjs/common';
import { OutboundMessagesModule } from '../../modules/messaging/outbound-messages/outbound-messages.module.js';
import { PromiseFirmingService } from './services/promise-firming.service.js';

/**
 * Firmness of the promise and order of preparation (ST-215.4, D-05, D-47). `SettingsService` is global.
 * The scheduled task of the 12 h window is added by stage 2.
 */
@Module({
    imports: [OutboundMessagesModule],
    providers: [PromiseFirmingService],
    exports: [PromiseFirmingService],
})
export class PromiseFirmingModule {}
