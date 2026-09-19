import { Module } from '@nestjs/common';
import { ApiMailerConfig } from './api.config.js';
import { ApiMailerAdapter } from './api.adapter.js';
import { MailerPort } from '../mailer.port.js';

@Module({
    providers: [
        ApiMailerConfig,
        ApiMailerAdapter,
        { provide: MailerPort, useExisting: ApiMailerAdapter },
    ],
    exports: [MailerPort],
})
export class ApiMailerModule {}
