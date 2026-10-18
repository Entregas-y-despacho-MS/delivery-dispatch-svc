import type { DataSource } from 'typeorm';
import { DispatchStatusPublicationService } from '../../src/modules/dispatch/dispatch-status-publication/dispatch-status-publication.service.js';
import { OutboxService } from '../../src/modules/messaging/outbound-messages/services/outbox.service.js';
import { MessageValidator } from '../../src/plugins/messaging/envelope/message-validator.js';

/** Builds the production publisher against the current test database and checked-in contracts. */
export function createDispatchStatusPublication(dataSource: DataSource): DispatchStatusPublicationService {
    return new DispatchStatusPublicationService(
        new OutboxService(dataSource, MessageValidator.fromDirectory()),
    );
}
