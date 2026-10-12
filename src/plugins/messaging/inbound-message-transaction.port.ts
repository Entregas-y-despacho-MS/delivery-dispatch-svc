import type { EntityManager } from 'typeorm';
import type { MessageEnvelope } from './envelope/message-envelope.js';

/** Options every repository call of a transactional handler must receive. */
export interface TransactionOptions {
    /**
     * The manager of the transaction. The TypeORM adapter always provides it; the in-memory adapter
     * provides `undefined` and the in-memory repositories ignore it.
     */
    manager?: EntityManager;
}

/**
 * What happened to the message:
 * - `receipt-committed`: the handler ran and its `processed` receipt was committed together with
 *   its business changes.
 * - `duplicate`: a `processed` receipt already existed; the handler did not run.
 */
export type TransactionalMessageResult = 'receipt-committed' | 'duplicate';

/**
 * Unit of work of a consumer that changes business data for one sales order. The adapter
 * serializes the processing of the order, runs `handle`, and commits the `processed` receipt of
 * `inbound_messages` in the same transaction as what `handle` wrote. If `handle` throws, nothing is
 * committed and the broker redelivers the message.
 *
 * Domain events must be emitted by the caller **after** `process` returns `receipt-committed`, never
 * inside `handle`; a `duplicate` emits nothing.
 */
export abstract class InboundMessageTransaction {
    abstract process(
        envelope: MessageEnvelope,
        salesOrderId: string,
        handle: (options: TransactionOptions) => Promise<void>,
    ): Promise<TransactionalMessageResult>;
}
