import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboundMessage } from './entities/outbound-message.entity.js';
import { OutboxPublisherConfig } from './services/outbox-publisher.config.js';
import { OutboxPublisherService } from './services/outbox-publisher.service.js';
import { OutboxService } from './services/outbox.service.js';

// MessageBus and MessageValidator come from the @Global() MessagingModule.
@Module({
    imports:   [TypeOrmModule.forFeature([OutboundMessage])],
    providers: [OutboxPublisherConfig, OutboxService, OutboxPublisherService],
    exports:   [OutboxService, OutboxPublisherService],
})
export class OutboundMessagesModule {}
