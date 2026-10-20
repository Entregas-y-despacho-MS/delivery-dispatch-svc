import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Time limits of the SMTP transport (nodemailer waits 2 min to connect, 30 s for the greeting and 10 min of
 * socket silence by default). A send holds a customer notice "in flight" (`NOTICE_LEASE_MINUTES`), so these
 * bound how long that can last: connect + greeting + one `socketTimeout` per command, a few minutes at worst.
 */
export const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
export const SMTP_GREETING_TIMEOUT_MS = 10_000;
export const SMTP_SOCKET_TIMEOUT_MS = 30_000;

@Injectable()
export class SmtpConfig {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly pass: string;
    readonly from: string;

    constructor(cfg: ConfigService) {
        this.host = cfg.get<string>('SMTP_HOST', 'smtp.example.com');
        this.port = cfg.get<number>('SMTP_PORT', 587)!;
        this.user = cfg.get<string>('SMTP_USER', '')!;
        this.pass = cfg.get<string>('SMTP_PASS', '')!;
        this.from = cfg.get<string>('SMTP_FROM', '"No Reply" <noreply@example.com>')!;
    }
}
