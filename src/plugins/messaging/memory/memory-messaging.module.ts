import { Module } from '@nestjs/common';
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
    exports: [MessageBus, InboundMessageLog, MemoryMessageBusAdapter, MemoryInboundMessageLogAdapter],
})
export class MemoryMessagingModule {}
