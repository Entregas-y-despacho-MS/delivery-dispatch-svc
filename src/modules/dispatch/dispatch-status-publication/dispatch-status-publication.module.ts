import { Module } from '@nestjs/common';
import { OutboundMessagesModule } from '../../messaging/outbound-messages/outbound-messages.module.js';
import { DispatchStatusPublicationService } from './dispatch-status-publication.service.js';

@Module({
    imports: [OutboundMessagesModule],
    providers: [DispatchStatusPublicationService],
    exports: [DispatchStatusPublicationService],
})
export class DispatchStatusPublicationModule {}
