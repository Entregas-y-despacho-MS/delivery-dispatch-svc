import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PubsubMessagingConfig {
    readonly projectId: string;
    /** `host:port` of the local emulator. Unset = real Google Cloud Pub/Sub with application default credentials. */
    readonly emulatorHost: string | undefined;
    /** Suffix of the subscription of this service: `<topic>.<suffix>` (created by scripts/pubsub/bootstrap.mjs). */
    readonly subscriptionSuffix: string;
    /** Physical topic for a shared inbound stream; unset keeps one subscription per logical topic. */
    readonly inboundTopic: string | undefined;
    /** Existing GCP subscription ID attached to `inboundTopic`; unset keeps the local convention. */
    readonly inboundSubscription: string | undefined;

    constructor(config: ConfigService) {
        this.projectId = config.get<string>('PUBSUB_PROJECT_ID')!;
        this.emulatorHost = config.get<string>('PUBSUB_EMULATOR_HOST') || undefined;
        this.subscriptionSuffix = config.get<string>('PUBSUB_SUBSCRIPTION_SUFFIX')!;
        this.inboundTopic = config.get<string>('PUBSUB_INBOUND_TOPIC') || undefined;
        this.inboundSubscription = config.get<string>('PUBSUB_INBOUND_SUBSCRIPTION') || undefined;
    }
}
