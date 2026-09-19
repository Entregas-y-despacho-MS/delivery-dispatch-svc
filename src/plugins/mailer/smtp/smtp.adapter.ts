import { Injectable, Logger } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { MailerPort, MailOptions } from '../mailer.port.js';

@Injectable()
export class SmtpAdapter extends MailerPort {
    private readonly logger = new Logger(SmtpAdapter.name);

    constructor(private readonly mailer: MailerService) {
        super();
    }

    // Fire-and-forget: returns immediately, email is sent in background.
    // Errors are logged but not thrown — a failed email should not break the HTTP response.
    send(options: MailOptions): void {
        setImmediate(async () => {
            try {
                await this.mailer.sendMail({
                    to:          options.to,
                    subject:     options.subject,
                    html:        options.html,
                    text:        options.text,
                    template:    options.template,
                    context:     options.context,
                    attachments: options.attachments,
                });
            } catch (err) {
                this.logger.error(`SMTP send failed: ${err.message}`, err.stack);
            }
        });
    }
}
