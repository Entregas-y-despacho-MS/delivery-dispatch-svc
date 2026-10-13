import { Module } from '@nestjs/common';
import { MessageValidator } from '../envelope/message-validator.js';
import { InboundMessageLog } from '../inbound-message-log.port.js';
import { InboundMessageRejection } from '../inbound-message-rejection.port.js';
import { MessageBus } from '../message-bus.port.js';
import { messageValidatorProvider } from '../messaging.providers.js';
import { MemoryInboundMessageLogAdapter } from './memory-inbound-message-log.adapter.js';
import { MemoryInboundMessageRejectionAdapter } from './memory-inbound-message-rejection.adapter.js';
import { MemoryInboundMessageTransactionAdapter } from './memory-inbound-message-transaction.adapter.js';
import { MemoryMessageBusAdapter } from './memory-message-bus.adapter.js';

@Module({
    providers: [
        messageValidatorProvider,
        MemoryInboundMessageLogAdapter,
        MemoryInboundMessageRejectionAdapter,
        MemoryInboundMessageTransactionAdapter,
        { provide: InboundMessageLog, useExisting: MemoryInboundMessageLogAdapter },
        { provide: InboundMessageRejection, useExisting: MemoryInboundMessageRejectionAdapter },
        MemoryMessageBusAdapter,
        { provide: MessageBus, useExisting: MemoryMessageBusAdapter },
    ],
    // The receipts stay private to this module (the tests reach them through the adapter class), so
    // they never compete with the database `InboundMessageLog` of InboundMessagesModule.
    // In the application, business handlers still use the database transaction even when the
    // broker is in memory. MemoryInboundMessageTransactionAdapter is exported for isolated runs.
    exports: [MessageBus, MessageValidator, MemoryMessageBusAdapter, MemoryInboundMessageLogAdapter, MemoryInboundMessageRejectionAdapter, MemoryInboundMessageTransactionAdapter],
})
export class MemoryMessagingModule {}
