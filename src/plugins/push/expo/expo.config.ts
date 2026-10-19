import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ExpoPushConfig {
    readonly accessToken: string;

    constructor(cfg: ConfigService) {
        this.accessToken = cfg.get<string>('EXPO_ACCESS_TOKEN', '')!;
    }
}
