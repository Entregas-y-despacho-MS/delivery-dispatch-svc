import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboundMessagesModule } from '../outbound-messages/outbound-messages.module.js';
import { DeliveryComplaintCase } from './entities/delivery-complaint-case.entity.js';
import { ComplaintConsumer } from './services/complaint-consumer.service.js';
import { ComplaintIntakeService } from './services/complaint-intake.service.js';

/**
 * ST-298.3 (8.9 reclamos de CRM). Consumes the complaint a CRM simulator publishes, validates the
 * delivered dispatch it refers to and queues the `received` / `rejected` acknowledgement in the
 * outbox. `InboundMessageTransaction` comes from the global `InboundMessagesModule`.
 */
@Module({
    imports:   [TypeOrmModule.forFeature([DeliveryComplaintCase]), OutboundMessagesModule],
    providers: [ComplaintIntakeService, ComplaintConsumer],
    exports:   [ComplaintIntakeService],
})
export class ComplaintIntakeModule {}
