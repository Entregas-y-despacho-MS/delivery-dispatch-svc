import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { MessageEnvelope } from '../../../plugins/messaging/envelope/message-envelope.js';
import { MessageValidator } from '../../../plugins/messaging/envelope/message-validator.js';
import { generateMessageId } from '../../../plugins/messaging/envelope/uuid-v7.js';
import { MemoryInboundMessageLogAdapter } from '../../../plugins/messaging/memory/memory-inbound-message-log.adapter.js';
import {
    MemoryInboundMessageTransactionAdapter,
    type MemoryTransactionParticipant,
} from '../../../plugins/messaging/memory/memory-inbound-message-transaction.adapter.js';
import { MemoryMessageBusAdapter } from '../../../plugins/messaging/memory/memory-message-bus.adapter.js';
import { InboundMessageTransaction, type TransactionOptions } from '../../../plugins/messaging/inbound-message-transaction.port.js';
import { DispatchStatusPublicationService } from '../../dispatch/dispatch-status-publication/dispatch-status-publication.service.js';
import { OutboxService } from '../outbound-messages/services/outbox.service.js';
import { WarehouseReceiptConsumer, INVENTORY_RECEIPT_CONFIRMED_TOPIC } from './services/warehouse-receipt-consumer.service.js';
import { WarehouseReceiptIntakeService } from './services/warehouse-receipt-intake.service.js';

/**
 * ST-240.3 — the whole receipt circuit without Docker: the real bus validation, consumer, intake service,
 * publication service and outbox validation, over an in-memory stand-in for the SQL the intake runs. It checks
 * what the ticket asks: the result reaches the outbox in the same transaction as the status change, a broker
 * outage never blocks it (the broker is only touched by `OutboxPublisherService`, later), and a redelivery
 * publishes nothing twice.
 */
const CONTRACTS_DIR = resolve(process.cwd(), 'contracts/messages');
const RECEIVED_AT = '2026-11-08T12:00:00Z';

interface State {
    dispatch: { id: number; type: string; ref: string; tracking: string | null; status: string; version: number };
    receipts: Record<string, { record_version: number; status: string; dispatch_id: number | null; result: string }>;
    items: Record<string, unknown>[];
    events: { metadata: Record<string, unknown> }[];
    incidents: { id: string; dispatchId: number }[];
    outbox: MessageEnvelope[];
}

/** Answers, by statement, the queries `WarehouseReceiptIntakeService` and `DispatchStatusPublicationService` run. */
class FakeStore implements MemoryTransactionParticipant<State> {
    state: State;

    constructor(dispatch: Partial<State['dispatch']> = {}) {
        this.state = {
            dispatch: { id: 55, type: 'supplier_pickup', ref: 'PO-2026-000087', tracking: 'DSP-2026-00045', status: 'picked_up_in_transit', version: 3, ...dispatch },
            receipts: {}, items: [], events: [], incidents: [], outbox: [],
        };
    }

    snapshot(): State { return structuredClone(this.state); }
    restore(snapshot: State): void { this.state = snapshot; }

    readonly manager = {
        query: async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
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
                Object.assign(s.receipts[receiptId], { record_version: recordVersion, result });
                return [];
            }
            if (sql.includes('DELETE FROM warehouse_receipt_items')) { s.items = []; return []; }
            if (sql.includes('INSERT INTO warehouse_receipt_items')) {
                const [, packageId, itemCode, accepted, missing, damaged, detail] = params as unknown[];
                s.items.push({ packageId, itemCode, accepted, missing, damaged, detail });
                return [];
            }
            if (sql.includes('AS dispatch_type')) {
                return [{ dispatch_type: s.dispatch.type, source_order_ref: s.dispatch.ref, tracking_code: s.dispatch.tracking }];
            }
            if (sql.includes('d.source_order_ref = $1')) {
                const d = s.dispatch;
                return d.ref === params[0] && d.type === params[1]
                    ? [{ dispatch_id: d.id, status: d.status, version: d.version, route_batch_id: null, tracking_code: d.tracking }]
                    : [];
            }
            if (sql.includes('UPDATE dispatches')) {
                s.dispatch.status = params[1] as string;
                return [[{ version: s.dispatch.version, updated_at: new Date('2026-11-08T12:00:05Z') }], 1];
            }
            if (sql.includes('FROM incident_reasons')) return [{ incident_reason_id: 6 }];
            if (sql.includes('outboundRecordVersion')) {
                const versions = s.events.map((e) => Number(e.metadata.outboundRecordVersion)).filter((v) => v > 0);
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

/** Hands the store's manager to the handler, as the PostgreSQL adapter hands its transaction manager. */
class StoreTransaction extends InboundMessageTransaction {
    constructor(private readonly inner: MemoryInboundMessageTransactionAdapter, private readonly store: FakeStore) { super(); }
    async process(envelope: MessageEnvelope, key: string, handle: (options: TransactionOptions) => Promise<void>) {
        return await this.inner.process(envelope, key, (options) => handle({ ...options, manager: this.store.manager as never }));
    }
}

function circuit(dispatch: Partial<State['dispatch']> = {}) {
    const store = new FakeStore(dispatch);
    const validator = MessageValidator.fromDirectory(CONTRACTS_DIR);
    const log = new MemoryInboundMessageLogAdapter();
    const bus = new MemoryMessageBusAdapter(validator, log);
    const memoryTransaction = new MemoryInboundMessageTransactionAdapter(log);
    memoryTransaction.registerParticipant(store);
    const events = { emit: vi.fn() };
    const outbox = new OutboxService({} as never, validator);
    const publication = new DispatchStatusPublicationService(outbox);
    const dispatchEvents = { create: vi.fn(async (data: { metadata: Record<string, unknown> }) => { store.state.events.push({ metadata: data.metadata }); }) };
    const dispatchIncidents = { create: vi.fn(async (data: { id: string; dispatchId: number }) => { store.state.incidents.push({ id: data.id, dispatchId: data.dispatchId }); }) };
    const batchClosing = { closeIfComplete: vi.fn() };
    const intake = new WarehouseReceiptIntakeService(dispatchEvents as never, dispatchIncidents as never, publication, batchClosing as never);
    const consumer = new WarehouseReceiptConsumer(bus, new StoreTransaction(memoryTransaction, store), intake, events as never);
    return { store, bus, consumer, events };
}

function receipt(over: Record<string, unknown> = {}, messageId = generateMessageId()): MessageEnvelope {
    return {
        messageId,
        type: INVENTORY_RECEIPT_CONFIRMED_TOPIC,
        source: 'inventory',
        schemaVersion: 1,
        occurredAt: RECEIVED_AT,
        data: {
            receiptId: 'RCP-2026-000310',
            recordVersion: 1,
            updatedAt: RECEIVED_AT,
            receivedAt: RECEIVED_AT,
            warehouseId: 'WH-LPZ-01',
            referenceType: 'purchase_order',
            referenceId: 'PO-2026-000087',
            trackingCode: 'DSP-2026-00045',
            result: 'with_differences',
            items: [
                { itemId: 'SKU-LAP-14', expectedQuantity: 10, acceptedQuantity: 8, missingQuantity: 1, damagedQuantity: 1, notes: 'Una caja con golpe' },
                { itemId: 'SKU-MOUSE-02', expectedQuantity: 20, acceptedQuantity: 20 },
            ],
            notes: 'Diferencias informadas al repartidor',
            ...over,
        },
    };
}

const send = async (c: ReturnType<typeof circuit>, envelope: MessageEnvelope) => {
    await c.consumer.onModuleInit();
    return await c.bus.publishRaw(envelope.type, envelope);
};

describe('Warehouse receipt result publication (ST-240.3)', () => {
    it('writes the result for Compras in the outbox with the status change, and tells the board after commit', async () => {
        const c = circuit();

        expect(await send(c, receipt())).toBe('processed');

        expect(c.store.state.dispatch.status).toBe('incident');
        expect(c.store.state.outbox).toHaveLength(1);
        expect(c.store.state.outbox[0]).toMatchObject({
            type: 'dispatch.transfer.status_changed',
            source: 'dispatch',
            data: {
                purchaseOrderId: 'PO-2026-000087', trackingCode: 'DSP-2026-00045',
                status: 'incident', previousStatus: 'picked_up_in_transit', recordVersion: 1,
                result: 'with_differences',
                // Only the item with a difference, in the shape of the contract.
                items: [{ itemCode: 'SKU-LAP-14', acceptedQuantity: 8, missingQuantity: 1, damagedQuantity: 1, detail: 'Una caja con golpe' }],
            },
        });
        // The contract items are stored under the table's names, with explicit zero quantities.
        expect(c.store.state.items).toEqual([
            { packageId: null, itemCode: 'SKU-LAP-14', accepted: 8, missing: 1, damaged: 1, detail: 'Una caja con golpe' },
            { packageId: null, itemCode: 'SKU-MOUSE-02', accepted: 20, missing: 0, damaged: 0, detail: null },
        ]);
        expect(c.events.emit.mock.calls.map(([name]) => name)).toEqual(['dispatch.status_changed', 'dispatch.incident_reported']);
        expect(c.events.emit).toHaveBeenCalledWith('dispatch.incident_reported', expect.objectContaining({
            dispatchId: 55, reasonCode: 'INC-RECEIPT-DIFF', criticality: 'high', incidentId: c.store.state.incidents[0].id,
        }));
    });

    it('does not depend on the broker: the transition commits and the message waits in the outbox', async () => {
        const c = circuit();
        // Broker down: anything that tried to publish during the transaction would throw and roll it back.
        const brokerDown = vi.spyOn(c.bus, 'publish').mockRejectedValue(new Error('broker down'));

        const outcome = await send(c, receipt());

        expect(outcome).toBe('processed');
        expect(c.bus.handlerErrors).toEqual([]);
        expect(brokerDown).not.toHaveBeenCalled();
        expect(c.store.state.dispatch.status).toBe('incident');
        expect(c.store.state.outbox).toHaveLength(1); // delivered later by OutboxPublisherService (retries in outbox.integration.spec)
    });

    it('publishes a complete supplier pickup as delivered, with the result and no items', async () => {
        const c = circuit();

        await send(c, receipt({ result: 'complete', items: [{ itemId: 'SKU-1', expectedQuantity: 10, acceptedQuantity: 10 }] }));

        expect(c.store.state.dispatch.status).toBe('delivered');
        const data = c.store.state.outbox[0].data;
        expect(data).toMatchObject({ status: 'delivered', result: 'complete' });
        expect(data).not.toHaveProperty('items');
        expect(c.events.emit.mock.calls.map(([name]) => name)).toEqual(['dispatch.status_changed']);
    });

    it('publishes nothing twice when the same message is delivered again', async () => {
        const c = circuit();
        const envelope = receipt();

        await send(c, envelope);
        const again = await c.bus.publishRaw(envelope.type, envelope);

        expect(again).toBe('duplicate');
        expect(c.store.state.outbox).toHaveLength(1);
        expect(c.events.emit).toHaveBeenCalledTimes(2); // status + incident, once
    });

    it('publishes nothing twice when Almacén resends the receipt under a new messageId and the same recordVersion', async () => {
        const c = circuit();

        await send(c, receipt());
        await c.bus.publishRaw(INVENTORY_RECEIPT_CONFIRMED_TOPIC, receipt());

        expect(c.store.state.outbox).toHaveLength(1);
        expect(c.store.state.incidents).toHaveLength(1);
        expect(c.events.emit).toHaveBeenCalledTimes(2);
    });

    it('publishes nothing for a correction of an already applied receipt: it needs a person', async () => {
        const c = circuit();

        await send(c, receipt());
        await c.bus.publishRaw(INVENTORY_RECEIPT_CONFIRMED_TOPIC, receipt({ recordVersion: 2, result: 'complete' }));

        expect(c.store.state.outbox).toHaveLength(1);
        expect(c.store.state.dispatch.status).toBe('incident');
        expect(c.events.emit).toHaveBeenLastCalledWith('dispatch.change_requires_attention', expect.objectContaining({ changeType: 'receipt_correction' }));
    });

    it('sends an RMA that ends in incident to Inventarios, and nothing for a complete one', async () => {
        const rejected = circuit({ type: 'warehouse_return_pickup', ref: 'RMA-1' });
        await send(rejected, receipt({ referenceType: 'rma', referenceId: 'RMA-1', result: 'rejected' }));
        expect(rejected.store.state.outbox[0].data).toMatchObject({ salesOrderId: 'RMA-1', status: 'incident', result: 'rejected' });

        const complete = circuit({ type: 'warehouse_return_pickup', ref: 'RMA-1' });
        await send(complete, receipt({ referenceType: 'rma', referenceId: 'RMA-1', result: 'complete', items: [{ itemId: 'SKU-1', expectedQuantity: 1, acceptedQuantity: 1 }] }));
        expect(complete.store.state.dispatch.status).toBe('returned_to_warehouse');
        expect(complete.store.state.outbox).toHaveLength(0);
        expect(complete.events.emit.mock.calls.map(([name]) => name)).toEqual(['dispatch.status_changed']);
    });

    it('rolls everything back, and tells nobody, when the message cannot be queued', async () => {
        const c = circuit({ tracking: null }); // the contract requires a tracking code

        await send(c, receipt({ trackingCode: undefined }));

        expect(c.bus.handlerErrors).toHaveLength(1);
        expect(c.store.state.dispatch.status).toBe('picked_up_in_transit');
        expect(c.store.state.receipts).toEqual({});
        expect(c.store.state.outbox).toHaveLength(0);
        expect(c.events.emit).not.toHaveBeenCalled();
    });
});
