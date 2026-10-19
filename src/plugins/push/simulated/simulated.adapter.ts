import { PushPort, type PushMessage, type PushReceiptOutcome, type PushReceiptReference, type PushSendOutcome } from '../push.port.js';

/** In-memory provider for deterministic tests; it is intentionally not registered in production DI. */
export class SimulatedPushAdapter extends PushPort {
    readonly sent: PushMessage[] = [];
    readonly receiptRequests: PushReceiptReference[][] = [];
    readonly sendResults: PushSendOutcome[][] = [];
    readonly receiptResults: PushReceiptOutcome[][] = [];

    async send(messages: PushMessage[]): Promise<PushSendOutcome[]> {
        this.sent.push(...messages);
        return this.sendResults.shift() ?? messages.map(({ to }) => ({ token: to, status: 'accepted' }));
    }

    async getReceipts(receipts: PushReceiptReference[]): Promise<PushReceiptOutcome[]> {
        this.receiptRequests.push(receipts);
        return this.receiptResults.shift() ?? [];
    }
}
