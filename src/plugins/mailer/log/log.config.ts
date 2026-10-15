import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class LogMailerConfig {
    readonly bounceEmail: string;

    constructor(config: ConfigService) {
        this.bounceEmail = config.get<string>('MAILER_BOUNCE_EMAIL', 'bounce@example.test')!.trim().toLowerCase();
    }
}
