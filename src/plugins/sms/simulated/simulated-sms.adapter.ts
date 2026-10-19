import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmsSender, type SmsMessage } from '../sms.port.js';

@Injectable()
export class SimulatedSmsAdapter extends SmsSender {
    private readonly logger = new Logger(SimulatedSmsAdapter.name);

    constructor(private readonly config: ConfigService) { super(); }

    async send(message: SmsMessage): Promise<void> {
        // Explicit local-only exception: validated boolean true AND development are both required.
        // A true flag in production, test, debug or another shared environment is ignored.
        const logBody = this.config.get<string>('NODE_ENV') === 'development'
            && this.config.get<boolean>('SMS_SIMULATED_LOG_BODY', false) === true;
        if (logBody) {
            const suffix = message.to.slice(-4);
            const recipient = message.to.length > 4 ? `****${suffix}` : '****';
            this.logger.log({ event: 'sms.sent', adapter: 'simulated', recipient, message: message.body });
            return;
        }
        this.logger.log({ event: 'sms.sent', adapter: 'simulated', message: '[REDACTED]' });
    }
}
