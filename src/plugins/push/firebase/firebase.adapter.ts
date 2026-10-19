import { Injectable, Logger } from '@nestjs/common';
import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import {
    PushPort,
    type PushMessage,
    type PushReceiptOutcome,
    type PushReceiptReference,
    type PushSendOutcome,
} from '../push.port.js';
import { FirebasePushConfig } from './firebase.config.js';

@Injectable()
export class FirebasePushAdapter extends PushPort {
    private readonly logger = new Logger(FirebasePushAdapter.name);
    private app?: App;

    constructor(private readonly config: FirebasePushConfig) {
        super();
    }

    async send(messages: PushMessage[]): Promise<PushSendOutcome[]> {
        return await Promise.all(messages.map(async ({ to, title, body, data }) => {
            try {
                await getMessaging(this.getApp()).send({
                    fid: to,
                    notification: { title, body },
                    data: data ? Object.fromEntries(Object.entries(data).map(([key, value]) => [key, String(value)])) : undefined,
                });
                return { token: to, status: 'accepted' } as const;
            } catch (error) {
                const code = firebaseErrorCode(error);
                if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
                    return { token: to, status: 'invalid-token', error: code } as const;
                }
                const status = isTransientFirebaseError(code) ? 'retryable-error' : 'permanent-error';
                this.logger.warn(`Firebase push failed (${status}): ${code || errorMessage(error)}`);
                return { token: to, status, error: code || errorMessage(error) } as const;
            }
        }));
    }

    async getReceipts(_references: PushReceiptReference[]): Promise<PushReceiptOutcome[]> {
        return [];
    }

    // Lazy initialization keeps invalid credentials from preventing the API from starting.
    private getApp(): App {
        if (!this.app) {
            this.app = getApps()[0] ?? initializeApp({
                credential: cert({
                    projectId: this.config.projectId,
                    clientEmail: this.config.clientEmail,
                    privateKey: this.config.privateKey,
                }),
            });
        }
        return this.app;
    }
}

function firebaseErrorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

function isTransientFirebaseError(code: string | undefined): boolean {
    return code !== undefined && [
        'messaging/server-unavailable',
        'messaging/internal-error',
        'messaging/unknown-error',
        'messaging/quota-exceeded',
        'app/network-error',
    ].includes(code);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
