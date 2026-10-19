export interface SmsMessage {
    to: string;
    /** Sensitive transient content. Adapters must never log or persist it. */
    body: string;
}

export abstract class SmsSender {
    abstract send(message: SmsMessage): Promise<void>;
}
