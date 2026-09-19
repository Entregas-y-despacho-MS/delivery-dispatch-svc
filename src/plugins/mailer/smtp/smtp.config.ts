import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
