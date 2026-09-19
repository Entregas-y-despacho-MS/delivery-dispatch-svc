export interface PushOptions {
    to:     string; // Expo push token, registered by the mobile app on login
    title:  string;
    body:   string;
    data?:  Record<string, unknown>;
}

// Contract for push notifications — independent of the underlying provider.
// Consumers inject PushPort, never the concrete adapter.
export abstract class PushPort {
    // Fire-and-forget, same convention as MailerPort — a failed push should not break the request.
    abstract send(options: PushOptions): void;
}
