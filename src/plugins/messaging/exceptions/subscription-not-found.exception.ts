export class SubscriptionNotFoundException extends Error {
    constructor(subscription: string) {
        super(
            `Pub/Sub subscription "${subscription}" does not exist. ` +
                'Create the topics and subscriptions first (scripts/pubsub/bootstrap.mjs or docker compose up).',
        );
        this.name = SubscriptionNotFoundException.name;
    }
}
