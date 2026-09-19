import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Compatible with Resend out of the box.
// For SendGrid or Mailgun: adjust ApiMailerAdapter.buildPayload() — nothing else changes.
@Injectable()
export class ApiMailerConfig {
    readonly apiUrl: string;
    readonly apiKey: string;
    readonly from:   string;

    constructor(cfg: ConfigService) {
        this.apiUrl = cfg.get<string>('MAILER_API_URL', 'https://api.resend.com/emails')!;
        this.apiKey = cfg.get<string>('MAILER_API_KEY', '')!;
        this.from   = cfg.get<string>('MAILER_FROM', '"No Reply" <noreply@example.com>')!;
    }
}
