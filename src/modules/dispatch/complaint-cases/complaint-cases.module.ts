import { Module } from '@nestjs/common';
import { OutboundMessagesModule } from '../../messaging/outbound-messages/outbound-messages.module.js';
import { ComplaintCasesController } from './controllers/complaint-cases.controller.js';
import { ComplaintCaseCommandsService } from './services/complaint-case-commands.service.js';
import { ComplaintCasesService } from './services/complaint-cases.service.js';

// ST-45.2: complaint inbox (read side) and its three commands. Both run raw SQL through the DataSource; the
// commands queue the RMA authorization request in the outbox, inside the transaction of the verdict.
@Module({
    imports:     [OutboundMessagesModule],
    controllers: [ComplaintCasesController],
    providers:   [ComplaintCasesService, ComplaintCaseCommandsService],
    exports:     [ComplaintCasesService, ComplaintCaseCommandsService],
})
export class ComplaintCasesModule {}
