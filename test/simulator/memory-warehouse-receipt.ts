import { vi } from 'vitest';
import { InboundMessageTransaction, type TransactionOptions } from '../../src/plugins/messaging/inbound-message-transaction.port.js';
import type { MessageEnvelope } from '../../src/plugins/messaging/envelope/message-envelope.js';
import type { MessageValidator } from '../../src/plugins/messaging/envelope/message-validator.js';
import type {
    MemoryInboundMessageTransactionAdapter,
    MemoryTransactionParticipant,
} from '../../src/plugins/messaging/memory/memory-inbound-message-transaction.adapter.js';
import { DispatchStatusPublicationService } from '../../src/modules/dispatch/dispatch-status-publication/dispatch-status-publication.service.js';
import { OutboxService } from '../../src/modules/messaging/outbound-messages/services/outbox.service.js';
import { WarehouseReceiptIntakeService } from '../../src/modules/messaging/warehouse-receipt-intake/services/warehouse-receipt-intake.service.js';
import type { MemoryPickupOrderService } from './memory-rma-pickup.js';

/**
 * In-memory stand-in for the SQL that `WarehouseReceiptIntakeService` and `DispatchStatusPublicationService` run
 * (ST-240.4), shared by the simulator harness. Dispatches are not stored here: they are the ones the RMA consumer
 * (`MemoryPickupOrderService.records`) and the procurement consumer already created, found lazily the first time a
 * receipt asks for them. Like the PostgreSQL adapter, it takes part in the rollback of the inbound transaction.
 *
 * It answers by statement, so it only understands what those two services run; anything else throws.
 */
export type DispatchKind = 'warehouse_return_pickup' | 'supplier_pickup';

export interface StoredDispatch {
    id: number;
    type: DispatchKind;
    ref: string;
    tracking: string;
    status: string;
    version: number;
}

export interface StoredReceipt {
    record_version: number;
    status: string;
    dispatch_id: number | null;
    result: string;
}

interface State {
    dispatches: StoredDispatch[];
    receipts: Record<string, StoredReceipt>;
    items: Array<Record<string, unknown>>;
    events: Array<{ dispatchId: number; metadata: Record<string, unknown> }>;
    incidents: Array<{ id: string; dispatchId: number }>;
    outbox: MessageEnvelope[];
}

/** First id of the supplier pickups: far from the RMA ones, which the in-memory pickup service numbers from 1. */
const SUPPLIER_DISPATCH_ID_BASE = 1000;
const RECEIVED_STATUS_UPDATE_AT = new Date('2026-11-09T12:40:15Z');

export class MemoryWarehouseReceiptStore implements MemoryTransactionParticipant<State> {
    private state: State = { dispatches: [], receipts: {}, items: [], events: [], incidents: [], outbox: [] };

    constructor(
        private readonly rmaPickups: MemoryPickupOrderService,
        /** What the recording double of the Compras repository was asked to create (`applyRequested`). */
        private readonly supplierRequests: { requested: unknown[] },
    ) {}

    get dispatches(): StoredDispatch[] { this.sync(); return this.state.dispatches; }
    get receipts(): Record<string, StoredReceipt> { return this.state.receipts; }
    get items(): Array<Record<string, unknown>> { return this.state.items; }
    get events(): State['events'] { return this.state.events; }
    get incidents(): State['incidents'] { return this.state.incidents; }
    /** What `OutboxService` queued, in order: what `OutboxPublisherService` would send to the broker later. */
    get outbox(): MessageEnvelope[] { return this.state.outbox; }

    dispatchOf(ref: string, type: DispatchKind): StoredDispatch | undefined {
        return this.dispatches.find((d) => d.ref === ref && d.type === type);
    }

    /** The courier picked the load up (what ES-239/ES-80 do in production): the dispatch can now be received. */
    forceStatus(ref: string, type: DispatchKind, status: string): StoredDispatch {
        const dispatch = this.dispatchOf(ref, type);
        if (!dispatch) throw new Error(`No ${type} dispatch for ${ref}: publish its request first.`);
        dispatch.status = status;
        return dispatch;
    }

    snapshot(): State { return structuredClone(this.state); }
    restore(snapshot: State): void { this.state = snapshot; }

    /** Adds the dispatches the consumers created since the last look, as `pickup_scheduled` (the state they are born in). */
    private sync(): void {
        for (const record of this.rmaPickups.records) {
            if (this.state.dispatches.some((d) => d.type === 'warehouse_return_pickup' && d.id === record.dispatchId)) continue;
            this.state.dispatches.push({
                id: record.dispatchId, type: 'warehouse_return_pickup', ref: record.rmaId,
                tracking: trackingCode(record.dispatchId), status: record.status, version: 1,
            });
        }
        (this.supplierRequests.requested as Array<{ purchaseOrderId: string }>).forEach((request, index) => {
            const id = SUPPLIER_DISPATCH_ID_BASE + index;
            if (this.state.dispatches.some((d) => d.id === id)) return;
            this.state.dispatches.push({
                id, type: 'supplier_pickup', ref: request.purchaseOrderId,
                tracking: trackingCode(id), status: 'pickup_scheduled', version: 1,
            });
        });
    }

    readonly manager = {
        query: async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
            this.sync();
            const s = this.state;
            if (sql.includes('FROM warehouse_receipts WHERE receipt_id')) {
                const row = s.receipts[params[0] as string];
                return row ? [row] : [];
            }
            if (sql.includes('INSERT INTO warehouse_receipts')) {
                const [receiptId, dispatchId, , , result, , recordVersion, , status] = params as [string, number | null, unknown, unknown, string, unknown, number, unknown, string];
                s.receipts[receiptId] = { record_version: recordVersion, status, dispatch_id: dispatchId, result };
                return [];
            }
            if (sql.includes('UPDATE warehouse_receipts')) {
                const [receiptId, recordVersion, , result] = params as [string, number, unknown, string];
                Object.assign(s.receipts[receiptId]!, { record_version: recordVersion, result });
                return [];
            }
            if (sql.includes('DELETE FROM warehouse_receipt_items')) { s.items = s.items.filter((i) => i['receiptId'] !== params[0]); return []; }
            if (sql.includes('INSERT INTO warehouse_receipt_items')) {
                const [receiptId, packageId, itemCode, accepted, missing, damaged, detail] = params as unknown[];
                s.items.push({ receiptId, packageId, itemCode, accepted, missing, damaged, detail });
                return [];
            }
            if (sql.includes('AS dispatch_type')) {
                const d = s.dispatches.find((x) => x.id === params[0]);
                return d ? [{ dispatch_type: d.type, source_order_ref: d.ref, tracking_code: d.tracking }] : [];
            }
            if (sql.includes('d.source_order_ref = $1')) {
                const d = s.dispatches.find((x) => x.ref === params[0] && x.type === params[1]);
                return d ? [{ dispatch_id: d.id, status: d.status, version: d.version, route_batch_id: null, tracking_code: d.tracking }] : [];
            }
            if (sql.includes('UPDATE dispatches')) {
                const d = s.dispatches.find((x) => x.id === params[0])!;
                d.status = params[1] as string;
                d.version += 1;
                return [[{ version: d.version, updated_at: RECEIVED_STATUS_UPDATE_AT }], 1];
            }
            if (sql.includes('FROM incident_reasons')) return [{ incident_reason_id: 6 }];
            if (sql.includes('outboundRecordVersion')) {
                const versions = s.events
                    .filter((e) => e.dispatchId === params[0])
                    .map((e) => Number(e.metadata['outboundRecordVersion']))
                    .filter((v) => v > 0);
                return [{ version: versions.length > 0 ? String(Math.max(...versions)) : null }];
            }
            if (sql.includes('INSERT INTO outbound_messages')) {
                const envelope = JSON.parse(params[2] as string) as MessageEnvelope;
                if (s.outbox.some((m) => m.messageId === envelope.messageId)) return [];
                s.outbox.push(envelope);
                return [{ message_id: envelope.messageId }];
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        },
    };
}

function trackingCode(dispatchId: number): string {
    return `DSP-2026-${String(dispatchId).padStart(5, '0')}`;
}

/** Hands the store's manager to the handler, as the PostgreSQL adapter hands its transaction manager. */
export class StoreTransaction extends InboundMessageTransaction {
    constructor(
        private readonly inner: MemoryInboundMessageTransactionAdapter,
        private readonly store: MemoryWarehouseReceiptStore,
    ) {
        super();
    }

    async process(envelope: MessageEnvelope, key: string, handle: (options: TransactionOptions) => Promise<void>) {
        return await this.inner.process(envelope, key, (options) => handle({ ...options, manager: this.store.manager as never }));
    }
}

/** The real intake service over the in-memory store: real publication service and outbox (with the real schemas). */
export function createReceiptIntake(store: MemoryWarehouseReceiptStore, validator: MessageValidator) {
    const publication = new DispatchStatusPublicationService(new OutboxService({} as never, validator));
    const dispatchEvents = {
        create: vi.fn(async (data: { dispatchId: number; metadata: Record<string, unknown> }) => {
            store.events.push({ dispatchId: data.dispatchId, metadata: data.metadata });
        }),
    };
    const dispatchIncidents = {
        create: vi.fn(async (data: { id: string; dispatchId: number }) => {
            store.incidents.push({ id: data.id, dispatchId: data.dispatchId });
        }),
    };
    const batchClosing = { closeIfComplete: vi.fn() };
    return new WarehouseReceiptIntakeService(dispatchEvents as never, dispatchIncidents as never, publication, batchClosing as never);
}
