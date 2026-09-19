import { Injectable, Logger } from '@nestjs/common';
import { PushPort, PushOptions } from '../push.port.js';
import { ExpoPushConfig } from './expo.config.js';

// Expo mediates with FCM/APNs under the hood — the app only ever needs the
// "Expo push token" the mobile app registers once, no Firebase credentials here.
@Injectable()
export class ExpoPushAdapter extends PushPort {
    private readonly logger = new Logger(ExpoPushAdapter.name);

    constructor(private readonly config: ExpoPushConfig) {
        super();
    }

    send(options: PushOptions): void {
        setImmediate(async () => {
            try {
                const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                if (this.config.accessToken) headers['Authorization'] = `Bearer ${this.config.accessToken}`;

                const response = await fetch(this.config.apiUrl, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        to:    options.to,
                        title: options.title,
                        body:  options.body,
                        data:  options.data,
                    }),
                });

                // fetch does not throw on 4xx/5xx — check response.ok manually.
                if (!response.ok) {
                    const body = await response.text();
                    this.logger.error(`Expo push error ${response.status}: ${body}`);
                }
            } catch (err) {
                this.logger.error(`Expo push network error: ${err.message}`, err.stack);
            }
        });
    }
}
