import { Module } from '@nestjs/common';
import { MessageValidator } from '../envelope/message-validator.js';
import { InboundMessageLog } from '../inbound-message-log.port.js';
import { MessageBus } from '../message-bus.port.js';
import { messageValidatorProvider } from '../messaging.providers.js';
import { MemoryInboundMessageLogAdapter } from './memory-inbound-message-log.adapter.js';
import { MemoryMessageBusAdapter } from './memory-message-bus.adapter.js';

@Module({
    providers: [
        messageValidatorProvider,
        MemoryInboundMessageLogAdapter,
        { provide: InboundMessageLog, useExisting: MemoryInboundMessageLogAdapter },
        MemoryMessageBusAdapter,
        { provide: MessageBus, useExisting: MemoryMessageBusAdapter },
    ],
    // The receipts stay private to this module (the tests reach them through the adapter class), so
    // they never compete with the database `InboundMessageLog` of InboundMessagesModule.
    exports: [MessageBus, MessageValidator, MemoryMessageBusAdapter, MemoryInboundMessageLogAdapter],
})
export class MemoryMessagingModule {}
