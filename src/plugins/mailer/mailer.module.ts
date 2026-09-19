import { DynamicModule, Global, Module } from '@nestjs/common';
import { SmtpMailerModule } from './smtp/smtp.module.js';
import { ApiMailerModule } from './api/api.module.js';

export type MailerTransport = 'smtp' | 'api';

/**
 * Port & Adapter facade for email sending.
 * Consumers inject MailerPort — the concrete transport is resolved at startup from MAILER_TRANSPORT.
 * Re-exports the adapter module so MailerPort is available app-wide via the @Global() decorator.
 */
@Global()
@Module({})
export class MailerModule {
    static register(transport?: MailerTransport): DynamicModule {
        // register() is static — DI is not available yet, so we read process.env directly.
        // dotenv/config is imported first in main.ts so process.env is populated by the time this runs.
        const chosen: MailerTransport =
            transport ?? ((process.env.MAILER_TRANSPORT as MailerTransport) || 'smtp');

        const adapterModule = chosen === 'api' ? ApiMailerModule : SmtpMailerModule;

        return {
            module:  MailerModule,
            imports: [adapterModule],
            // Re-export the whole adapter module — NestJS 11 requires re-exporting the module
            // that provides the token, not the token itself, when it originates from an import.
            exports: [adapterModule],
        };
    }
}
