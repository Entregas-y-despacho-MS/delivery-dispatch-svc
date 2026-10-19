export interface PushMessage {
    to:     string; // Token format depends on the selected provider.
    title:  string;
    body:   string;
    data?:  Record<string, unknown>;
}

export type PushSendOutcome =
    | { token: string; status: 'accepted'; receiptId?: string }
    | { token: string; status: 'invalid-token'; error: string }
    | { token: string; status: 'retryable-error'; error: string }
    | { token: string; status: 'permanent-error'; error: string };

export type PushReceiptOutcome =
    | { token: string; receiptId: string; status: 'ok' }
    | { token: string; receiptId: string; status: 'invalid-token'; error: string }
    | { token: string; receiptId: string; status: 'permanent-error'; error: string };

export interface PushReceiptReference {
    token: string;
    receiptId: string;
}

// Contract for push notifications — independent of the underlying provider.
// Consumers inject PushPort, never the concrete adapter.
export abstract class PushPort {
    abstract send(messages: PushMessage[]): Promise<PushSendOutcome[]>;

    /** Fetches provider receipts for tickets accepted earlier. Providers without receipts return []. */
    abstract getReceipts(receipts: PushReceiptReference[]): Promise<PushReceiptOutcome[]>;
}
