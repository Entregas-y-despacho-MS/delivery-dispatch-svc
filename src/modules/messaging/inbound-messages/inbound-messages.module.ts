import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InboundMessageLog } from '../../../plugins/messaging/inbound-message-log.port.js';
import { InboundMessageRejection } from '../../../plugins/messaging/inbound-message-rejection.port.js';
import { InboundMessage } from './entities/inbound-message.entity.js';
import { InboundMessagesService } from './services/inbound-messages.service.js';
import { InboundMessageTransactionService } from './services/inbound-message-transaction.service.js';
import { AuditInboundMessageRejectionAdapter } from './services/audit-inbound-message-rejection.adapter.js';

/** Provides the `InboundMessageLog` port (database adapter) that the Pub/Sub messaging adapter needs. */
@Global()
@Module({
    imports:   [TypeOrmModule.forFeature([InboundMessage])],
    providers: [
        InboundMessagesService,
        InboundMessageTransactionService,
        AuditInboundMessageRejectionAdapter,
        { provide: InboundMessageLog, useExisting: InboundMessagesService },
        { provide: InboundMessageRejection, useExisting: AuditInboundMessageRejectionAdapter },
    ],
    exports:   [InboundMessageLog, InboundMessageTransactionService, InboundMessageRejection],
})
export class InboundMessagesModule {}
