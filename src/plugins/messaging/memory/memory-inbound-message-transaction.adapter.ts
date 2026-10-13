import { Injectable } from '@nestjs/common';
import type { MessageEnvelope } from '../envelope/message-envelope.js';
import {
    InboundMessageTransaction,
    type TransactionalMessageResult,
    type TransactionOptions,
} from '../inbound-message-transaction.port.js';
import { MemoryInboundMessageLogAdapter } from './memory-inbound-message-log.adapter.js';

/** A memory business store can participate in rollback by exposing a snapshot of its state. */
export interface MemoryTransactionParticipant<T = unknown> {
    snapshot(): T;
    restore(snapshot: T): void;
}

/**
 * The memory counterpart of the PostgreSQL transaction. Serial execution makes duplicate checks
 * deterministic and keeps snapshots safe when a handler fails. Business stores used in rollback
 * checks register as participants; the receipt is always written only after the handler succeeds.
 */
@Injectable()
export class MemoryInboundMessageTransactionAdapter extends InboundMessageTransaction {
    private tail: Promise<void> = Promise.resolve();
    private readonly participants: MemoryTransactionParticipant[] = [];

    constructor(private readonly log: MemoryInboundMessageLogAdapter) {
        super();
    }

    registerParticipant(participant: MemoryTransactionParticipant): void {
        this.participants.push(participant);
    }

    async process(
        envelope: MessageEnvelope,
        _salesOrderId: string,
        handle: (options: TransactionOptions) => Promise<void>,
    ): Promise<TransactionalMessageResult> {
        const previous = this.tail;
        let release!: () => void;
        this.tail = new Promise<void>((resolve) => { release = resolve; });
        await previous;

        try {
            if (await this.log.wasProcessed(envelope.messageId)) return 'duplicate';

            const snapshots = this.participants.map((participant) => participant.snapshot());
            try {
                await handle({ manager: undefined });
                const recorded = await this.log.record({
                    messageId: envelope.messageId,
                    status: 'processed',
                    type: envelope.type,
                    source: envelope.source,
                });
                if (!recorded) throw new Error(`Could not commit receipt ${envelope.messageId}.`);
                return 'receipt-committed';
            } catch (error) {
                for (let i = this.participants.length - 1; i >= 0; i--) {
                    this.participants[i].restore(snapshots[i]);
                }
                throw error;
            }
        } finally {
            release();
        }
    }
}
