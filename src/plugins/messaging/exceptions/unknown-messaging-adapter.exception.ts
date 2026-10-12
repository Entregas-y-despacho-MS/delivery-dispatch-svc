export class UnknownMessagingAdapterException extends Error {
    constructor(adapter: string) {
        super(`Unknown MESSAGING_ADAPTER "${adapter}". Valid values: pubsub, memory.`);
        this.name = UnknownMessagingAdapterException.name;
    }
}
