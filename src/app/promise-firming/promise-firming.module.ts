import { Module } from '@nestjs/common';
import { OutboundMessagesModule } from '../../modules/messaging/outbound-messages/outbound-messages.module.js';
import { PromiseWindowCloseTask } from './promise-window-close.task.js';
import { PromiseFirmingService } from './services/promise-firming.service.js';
import { PromiseWindowCandidatesRepository } from './services/promise-window-candidates.repository.js';
import { PromiseWindowCloseService } from './services/promise-window-close.service.js';

/**
 * Firmness of the promise and order of preparation (ST-215.4, D-05, D-47). `SettingsService` and the
 * scheduler registry are global; the task registers itself in `onModuleInit`.
 */
@Module({
    imports: [OutboundMessagesModule],
    providers: [
        PromiseFirmingService,
        PromiseWindowCandidatesRepository,
        PromiseWindowCloseService,
        PromiseWindowCloseTask,
    ],
    exports: [PromiseFirmingService],
})
export class PromiseFirmingModule {}
