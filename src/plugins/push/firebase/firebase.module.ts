import { Module } from '@nestjs/common';
import { FirebasePushConfig } from './firebase.config.js';
import { FirebasePushAdapter } from './firebase.adapter.js';
import { PushPort } from '../push.port.js';

@Module({
    providers: [
        FirebasePushConfig,
        FirebasePushAdapter,
        { provide: PushPort, useExisting: FirebasePushAdapter },
    ],
    exports: [PushPort],
})
export class FirebasePushModule {}
