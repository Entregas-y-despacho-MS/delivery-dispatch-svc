import { Injectable, Logger } from '@nestjs/common';
import { MailerPort, MailOptions } from '../mailer.port.js';
import { ApiMailerConfig } from './api.config.js';

// Compatible with Resend by default. To switch providers (SendGrid, Mailgun, Postmark),
// override buildPayload() — the fire-and-forget logic stays the same.
@Injectable()
export class ApiMailerAdapter extends MailerPort {
    private readonly logger = new Logger(ApiMailerAdapter.name);

    constructor(private readonly config: ApiMailerConfig) {
        super();
    }

    send(options: MailOptions): void {
        setImmediate(async () => {
            try {
                const response = await fetch(this.config.apiUrl, {
                    method:  'POST',
                    headers: {
                        'Authorization': `Bearer ${this.config.apiKey}`,
                        'Content-Type':  'application/json',
                    },
                    body: JSON.stringify(this.buildPayload(options)),
                });

                // fetch does not throw on 4xx/5xx — check response.ok manually.
                if (!response.ok) {
                    const body = await response.text();
                    this.logger.error(`API mailer error ${response.status}: ${body}`);
                }
            } catch (err) {
                this.logger.error(`API mailer network error: ${err.message}`, err.stack);
            }
        });
    }

    private buildPayload(options: MailOptions): Record<string, unknown> {
        return {
            from:    this.config.from,
            to:      Array.isArray(options.to) ? options.to : [options.to],
            subject: options.subject,
            html:    options.html,
            text:    options.text,
        };
    }
}
