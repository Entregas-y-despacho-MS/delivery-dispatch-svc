import { Module } from '@nestjs/common';
import { Expo } from 'expo-server-sdk';
import { ExpoPushConfig } from './expo.config.js';
import { EXPO_CLIENT, ExpoPushAdapter } from './expo.adapter.js';
import { PushPort } from '../push.port.js';

@Module({
    providers: [
        ExpoPushConfig,
        {
            provide: EXPO_CLIENT,
            inject: [ExpoPushConfig],
            useFactory: (config: ExpoPushConfig) => new Expo({ accessToken: config.accessToken || undefined }),
        },
        {
            provide: ExpoPushAdapter,
            inject: [EXPO_CLIENT],
            useFactory: (client: Expo) => new ExpoPushAdapter(client),
        },
        { provide: PushPort, useExisting: ExpoPushAdapter },
    ],
    exports: [PushPort],
})
export class ExpoPushModule {}
