import { Module } from '@nestjs/common';
import { ExpoPushConfig } from './expo.config.js';
import { ExpoPushAdapter } from './expo.adapter.js';
import { PushPort } from '../push.port.js';

@Module({
    providers: [
        ExpoPushConfig,
        ExpoPushAdapter,
        { provide: PushPort, useExisting: ExpoPushAdapter },
    ],
    exports: [PushPort],
})
export class ExpoPushModule {}
