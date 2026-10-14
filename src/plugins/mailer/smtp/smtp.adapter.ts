import { Injectable, Logger } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { MailerPort, MailDeliveryResult, MailOptions } from '../mailer.port.js';

@Injectable()
export class SmtpAdapter extends MailerPort {
    private readonly logger = new Logger(SmtpAdapter.name);

    constructor(private readonly mailer: MailerService) {
        super();
    }

    async send(options: MailOptions): Promise<MailDeliveryResult> {
        try {
            const result = await this.mailer.sendMail({
                to:          options.to,
                subject:     options.subject,
                html:        options.html,
                text:        options.text,
                template:    options.template,
                context:     options.context,
                attachments: options.attachments,
            });
            if (result.rejected?.length) return { status: 'bounced' };
            return result.accepted?.length ? { status: 'sent' } : { status: 'failed', error: 'SMTP did not accept any recipient.' };
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            this.logger.error(`SMTP send failed: ${error}`);
            return { status: 'failed', error };
        }
    }
}
