import { Module } from '@nestjs/common';
import { MailerModule } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/adapters/handlebars.adapter';
import { join } from 'path';
import { SmtpConfig } from './smtp.config.js';
import { SmtpAdapter } from './smtp.adapter.js';
import { MailerPort } from '../mailer.port.js';

// process.cwd() (not __dirname) so this resolves the same under CJS and ESM builds
// — Nest always runs the compiled output from the project root.
const TEMPLATES_DIR = join(process.cwd(), 'dist', 'plugins', 'mailer', 'templates');

@Module({
    imports: [
        MailerModule.forRootAsync({
            imports:        [],
            extraProviders: [SmtpConfig],
            inject:         [SmtpConfig],
            useFactory: (cfg: SmtpConfig) => ({
                transport: {
                    host: cfg.host,
                    port: cfg.port,
                    auth: { user: cfg.user, pass: cfg.pass },
                },
                defaults: { from: cfg.from },
                template: {
                    adapter:  new HandlebarsAdapter(),
                    dir:      TEMPLATES_DIR,
                    options:  { strict: true },
                },
            }),
        }),
    ],
    providers: [
        SmtpConfig,
        SmtpAdapter,
        { provide: MailerPort, useExisting: SmtpAdapter },
    ],
    exports: [MailerPort],
})
export class SmtpMailerModule {}
