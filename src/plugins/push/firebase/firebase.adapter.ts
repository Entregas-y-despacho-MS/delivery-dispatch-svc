import { Injectable, Logger } from '@nestjs/common';
import { initializeApp, cert, App, getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { PushPort, PushOptions } from '../push.port.js';
import { FirebasePushConfig } from './firebase.config.js';

// PushOptions.to must be a Firebase Installation ID (FID) here — NOT an Expo push token
// (ExponentPushToken[...]) nor a legacy FCM registration token. firebase-admin's TokenMessage
// (the { token } shape) is marked @deprecated in favor of FidMessage ({ fid }) — verified against
// the installed package's own messaging-api.d.ts (firebase-admin 14.4.0), not assumed from memory.
// The mobile app's registration code has to produce a FID for whichever adapter is active
// (PUSH_PROVIDER) — that's outside what this Port & Adapter boundary covers.
@Injectable()
export class FirebasePushAdapter extends PushPort {
    private readonly logger = new Logger(FirebasePushAdapter.name);
    private app?: App;

    constructor(private readonly config: FirebasePushConfig) {
        super();
    }

    // Lazy: credentials are only parsed/validated on the first real send(), not at app boot —
    // consistent with CloudinaryAdapter (config stored, validated on first use, not eagerly).
    // A misconfigured FIREBASE_PRIVATE_KEY should only break push, not the whole server.
    private getApp(): App {
        if (!this.app) {
            this.app = getApps()[0] ?? initializeApp({
                credential: cert({
                    projectId:  this.config.projectId,
                    clientEmail:this.config.clientEmail,
                    privateKey: this.config.privateKey,
                }),
            });
        }
        return this.app;
    }

    send(options: PushOptions): void {
        setImmediate(async () => {
            try {
                await getMessaging(this.getApp()).send({
                    fid: options.to,
                    notification: { title: options.title, body: options.body },
                    data: options.data as Record<string, string> | undefined,
                });
            } catch (err) {
                this.logger.error(`Firebase push failed: ${err.message}`, err.stack);
            }
        });
    }
}
