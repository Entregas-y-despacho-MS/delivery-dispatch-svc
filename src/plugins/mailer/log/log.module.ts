import { Module } from '@nestjs/common';
import { MailerPort } from '../mailer.port.js';
import { LogMailerAdapter } from './log.adapter.js';
import { LogMailerConfig } from './log.config.js';

@Module({
    providers: [
        LogMailerConfig,
        LogMailerAdapter,
        { provide: MailerPort, useExisting: LogMailerAdapter },
    ],
    exports: [MailerPort],
})
export class LogMailerModule {}
