import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PubsubMessagingConfig {
    readonly projectId: string;
    /** `host:port` of the local emulator. Unset = real Google Cloud Pub/Sub with application default credentials. */
    readonly emulatorHost: string | undefined;
    /** Suffix of the subscription of this service: `<topic>.<suffix>` (created by scripts/pubsub/bootstrap.mjs). */
    readonly subscriptionSuffix: string;

    constructor(config: ConfigService) {
        this.projectId = config.get<string>('PUBSUB_PROJECT_ID')!;
        this.emulatorHost = config.get<string>('PUBSUB_EMULATOR_HOST') || undefined;
        this.subscriptionSuffix = config.get<string>('PUBSUB_SUBSCRIPTION_SUFFIX')!;
    }
}
