import { Injectable, Logger } from '@nestjs/common';
import { MailerPort, MailDeliveryResult, MailOptions } from '../mailer.port.js';
import { ApiMailerConfig } from './api.config.js';

// Compatible with Resend by default. To switch providers (SendGrid, Mailgun, Postmark),
// override buildPayload().
@Injectable()
export class ApiMailerAdapter extends MailerPort {
    private readonly logger = new Logger(ApiMailerAdapter.name);

    constructor(private readonly config: ApiMailerConfig) {
        super();
    }

    async send(options: MailOptions): Promise<MailDeliveryResult> {
        try {
            const response = await fetch(this.config.apiUrl, {
                method:  'POST',
                headers: {
                    'Authorization': `Bearer ${this.config.apiKey}`,
                    'Content-Type':  'application/json',
                },
                body: JSON.stringify(this.buildPayload(options)),
            });

            if (!response.ok) {
                const body = await response.text();
                this.logger.error(`API mailer error ${response.status}: ${body}`);
                return { status: 'failed', error: `API returned HTTP ${response.status}.` };
            }
            return { status: 'sent' };
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            this.logger.error(`API mailer network error: ${error}`);
            return { status: 'failed', error };
        }
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
