import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MAIL_DELIVERY_RESULT_EVENT, MailDeliveryResult, MailerPort, MailOptions } from '../mailer.port.js';
import { LogMailerConfig } from './log.config.js';

@Injectable()
export class LogMailerAdapter extends MailerPort {
    private readonly logger = new Logger(LogMailerAdapter.name);

    constructor(
        private readonly config: LogMailerConfig,
        private readonly events: EventEmitter2,
    ) {
        super();
    }

    async send(options: MailOptions): Promise<MailDeliveryResult> {
        const recipients = (Array.isArray(options.to) ? options.to : [options.to]).map((email) => email.trim());
        const bounced = recipients.some((email) => email.toLowerCase() === this.config.bounceEmail);
        const result: MailDeliveryResult = { status: bounced ? 'bounced' : 'sent' };
        this.logger.log(JSON.stringify({
            event: 'mailer.delivery_attempt',
            recipients,
            template: options.template ?? null,
            result: result.status,
        }));
        await this.events.emitAsync(MAIL_DELIVERY_RESULT_EVENT, { ...result, options });
        return result;
    }
}
