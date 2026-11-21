import { Module } from '@nestjs/common';
import { CustomerNotificationRecoveryTask } from './customer-notification-recovery.task.js';
import { CustomerStatusNoticeListener } from './customer-status-notice.listener.js';
import { CustomerStatusNoticeRepository } from './services/customer-status-notice.repository.js';
import { CustomerStatusNoticeService } from './services/customer-status-notice.service.js';

/**
 * Customer email on each delivery status change (ST-39.1, RF-U16), sent once and recoverable (ST-39.2).
 * The mailer, the event emitter and the task registry are global.
 */
@Module({ providers: [CustomerStatusNoticeRepository, CustomerStatusNoticeService, CustomerStatusNoticeListener, CustomerNotificationRecoveryTask] })
export class CustomerStatusNoticesModule {}
