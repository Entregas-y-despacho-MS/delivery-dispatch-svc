import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ExpoPushConfig {
    readonly apiUrl:      string;
    readonly accessToken: string;

    constructor(cfg: ConfigService) {
        this.apiUrl      = cfg.get<string>('EXPO_PUSH_API_URL', 'https://exp.host/--/api/v2/push/send')!;
        this.accessToken = cfg.get<string>('EXPO_ACCESS_TOKEN', '')!;
    }
}
