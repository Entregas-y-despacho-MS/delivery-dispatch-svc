import { Injectable, Logger } from '@nestjs/common';
import { SmsSender, type SmsMessage } from '../sms.port.js';

@Injectable()
export class SimulatedSmsAdapter extends SmsSender {
    private readonly logger = new Logger(SimulatedSmsAdapter.name);

    async send(_message: SmsMessage): Promise<void> {
        // Never pass caller-controlled content or the phone number to the logger.
        this.logger.log({ event: 'sms.sent', adapter: 'simulated', message: '[REDACTED]' });
    }
}
