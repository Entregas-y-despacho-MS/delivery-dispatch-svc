import { Module } from '@nestjs/common';
import { CustomerStatusNoticeListener } from './customer-status-notice.listener.js';
import { CustomerStatusNoticeRepository } from './services/customer-status-notice.repository.js';
import { CustomerStatusNoticeService } from './services/customer-status-notice.service.js';

/** Customer email on each delivery status change (ST-39.1, RF-U16). The mailer and the event emitter are global. */
@Module({ providers: [CustomerStatusNoticeRepository, CustomerStatusNoticeService, CustomerStatusNoticeListener] })
export class CustomerStatusNoticesModule {}
