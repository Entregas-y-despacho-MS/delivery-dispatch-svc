import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class FirebasePushConfig {
    readonly projectId:  string;
    readonly clientEmail:string;
    readonly privateKey: string;

    constructor(cfg: ConfigService) {
        this.projectId   = cfg.get<string>('FIREBASE_PROJECT_ID', '')!;
        this.clientEmail = cfg.get<string>('FIREBASE_CLIENT_EMAIL', '')!;
        // .env stores literal "\n" — service account JSON keys need real newlines.
        this.privateKey  = cfg.get<string>('FIREBASE_PRIVATE_KEY', '')!.replace(/\\n/g, '\n');
    }
}
