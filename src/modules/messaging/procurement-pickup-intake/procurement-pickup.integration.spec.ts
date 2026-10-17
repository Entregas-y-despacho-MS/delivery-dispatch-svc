import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MessageValidator } from '../../../plugins/messaging/envelope/message-validator.js';
import type { MessageEnvelope } from '../../../plugins/messaging/envelope/message-envelope.js';
import { MemoryInboundMessageLogAdapter } from '../../../plugins/messaging/memory/memory-inbound-message-log.adapter.js';
import { MemoryInboundMessageTransactionAdapter } from '../../../plugins/messaging/memory/memory-inbound-message-transaction.adapter.js';
import type { MemoryTransactionParticipant } from '../../../plugins/messaging/memory/memory-inbound-message-transaction.adapter.js';
import { MemoryMessageBusAdapter } from '../../../plugins/messaging/memory/memory-message-bus.adapter.js';
import type { TransactionOptions } from '../../../plugins/messaging/inbound-message-transaction.port.js';
import { generateMessageId } from '../../../plugins/messaging/envelope/uuid-v7.js';
import { PickupSchedulingService } from '../../dispatch/pickup-scheduling/services/pickup-scheduling.service.js';
import { OrderSyncStatePort, type OrderSyncState, type OrderSyncSource } from '../sales-order-sync/ports/order-sync-state.port.js';
import { DispatchChangeEvents } from '../sales-order-intake/services/dispatch-change-events.service.js';
import { ProcurementPickupRepository } from './repositories/procurement-pickup.repository.js';
import { ProcurementPickupConsumer } from './services/procurement-pickup-consumer.service.js';
import type {
  ProcurementPickupCancelledData,
  ProcurementPickupRequestedData,
  ProcurementPickupUpdatedData,
} from './domain/procurement-pickup-message.types.js';

const ORDER_ID = 'PO-2026-000087';
const CONTRACTS_DIR = resolve(process.cwd(), 'contracts/messages');

interface PickupRecord {
  dispatchId: number;
  purchaseOrderId: string;
  type: 'supplier_pickup';
  status: 'pending' | 'address_review' | 'scheduled' | 'cancelled';
  address: string | null;
  warehouseId: string | null;
  pickupWindow: { startsAt: string; endsAt: string } | null;
  weightKg: number | null;
  products: Array<{ productId: string; quantity: number }>;
}

class MemoryPickupRepository extends ProcurementPickupRepository implements MemoryTransactionParticipant<PickupRecord[]> {
  records: PickupRecord[] = [];

  snapshot(): PickupRecord[] {
    return structuredClone(this.records);
  }

  restore(snapshot: PickupRecord[]): void {
    this.records = snapshot;
  }

  async applyRequested(data: ProcurementPickupRequestedData, _options: TransactionOptions): Promise<null> {
    const existing = this.records.find((record) => record.purchaseOrderId === data.purchaseOrderId);
    const complete = Boolean(data.pickupAddress?.line && data.pickupWindow && data.warehouseId === 'WH-LPZ-01');
    const record: PickupRecord = {
      dispatchId: existing?.dispatchId ?? this.records.length + 1,
      purchaseOrderId: data.purchaseOrderId,
      type: 'supplier_pickup',
      status: complete ? 'pending' : 'address_review',
      address: data.pickupAddress?.line ?? null,
      warehouseId: data.warehouseId ?? null,
      pickupWindow: data.pickupWindow ?? null,
      weightKg: data.estimates?.weightKg ?? null,
      products: structuredClone(data.products),
    };
    if (existing) Object.assign(existing, record);
    else this.records.push(record);
    return null;
  }

  async applyUpdated(data: ProcurementPickupUpdatedData, _options: TransactionOptions): Promise<null> {
    const record = this.records.find((item) => item.purchaseOrderId === data.purchaseOrderId);
    if (!record) return null;
    if (data.pickupAddress) record.address = data.pickupAddress.line;
    if (data.pickupWindow) record.pickupWindow = structuredClone(data.pickupWindow);
    if (data.warehouseId !== undefined) record.warehouseId = data.warehouseId;
    if (data.estimates) record.weightKg = data.estimates.weightKg ?? null;
    if (data.products) record.products = structuredClone(data.products);
    if (record.status !== 'scheduled') {
      record.status = record.address && record.pickupWindow && record.warehouseId === 'WH-LPZ-01' ? 'pending' : 'address_review';
    }
    return null;
  }

  async applyCancelled(data: ProcurementPickupCancelledData, _options: TransactionOptions): Promise<null> {
    const record = this.records.find((item) => item.purchaseOrderId === data.purchaseOrderId);
    if (record && ['pending', 'address_review', 'scheduled'].includes(record.status)) record.status = 'cancelled';
    return null;
  }
}

class MemoryOrderSyncState extends OrderSyncStatePort implements MemoryTransactionParticipant<Map<string, OrderSyncState>> {
  private states = new Map<string, OrderSyncState>();

  snapshot(): Map<string, OrderSyncState> {
    return structuredClone(this.states);
  }

  restore(snapshot: Map<string, OrderSyncState>): void {
    this.states = snapshot;
  }

  async find(salesOrderId: string, source: OrderSyncSource): Promise<OrderSyncState | null> {
    return this.states.get(`${salesOrderId}:${source}`) ?? null;
  }

  async findAllOf(salesOrderId: string): Promise<OrderSyncState[]> {
    return [...this.states.values()].filter((state) => state.salesOrderId === salesOrderId);
  }

  async save(state: OrderSyncState): Promise<void> {
    this.states.set(`${state.salesOrderId}:${state.source}`, structuredClone(state));
  }
}

function pickupRequest(overrides: Record<string, unknown> = {}) {
  return {
    purchaseOrderId: ORDER_ID,
    recordVersion: 1,
    updatedAt: new Date().toISOString(),
    supplier: { supplierId: 'SUP-1', name: 'Proveedor Uno' },
    pickupAddress: { line: 'Av. Industrial 123', reference: 'Portón azul' },
    pickupWindow: {
      startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      endsAt: new Date(Date.now() + 30 * 60 * 60 * 1000).toISOString(),
    },
    warehouseId: 'WH-LPZ-01',
    products: [{ productId: 'SKU-1', quantity: 2 }],
    estimates: { packages: 2, weightKg: 400, volumeM3: 3 },
    ...overrides,
  };
}

function message(type: string, data: Record<string, unknown>, messageId = generateMessageId()): MessageEnvelope {
  return { messageId, type, source: 'procurement', schemaVersion: 1, occurredAt: new Date().toISOString(), data };
}

function buildConsumerCircuit() {
  const log = new MemoryInboundMessageLogAdapter();
  const validator = MessageValidator.fromDirectory(CONTRACTS_DIR);
  const bus = new MemoryMessageBusAdapter(validator, log);
  const transaction = new MemoryInboundMessageTransactionAdapter(log);
  const pickups = new MemoryPickupRepository();
  const syncStates = new MemoryOrderSyncState();
  transaction.registerParticipant(pickups);
  transaction.registerParticipant(syncStates);
  const events = { emitAfterCommit: vi.fn() } as unknown as DispatchChangeEvents;
  const consumer = new ProcurementPickupConsumer(bus, transaction, syncStates, pickups, events);
  return { bus, validator, pickups, syncStates, consumer };
}

describe('Procurement pickup messaging integration', () => {
  it('consumes a valid request and creates a pending supplier pickup', async () => {
    const { bus, pickups, consumer } = buildConsumerCircuit();
    await consumer.onModuleInit();
    const envelope = message('procurement.pickup.requested', pickupRequest());

    const outcome = await bus.publishRaw(envelope.type, envelope);

    expect(outcome).toBe('processed');
    expect(pickups.records).toHaveLength(1);
    expect(pickups.records[0]).toMatchObject({ type: 'supplier_pickup', status: 'pending', purchaseOrderId: ORDER_ID });
  });

  it('retains an incomplete request for address review when its warehouse is unknown', async () => {
    const { bus, pickups, consumer } = buildConsumerCircuit();
    await consumer.onModuleInit();
    const envelope = message('procurement.pickup.requested', pickupRequest({ warehouseId: 'WH-MISSING' }));

    const outcome = await bus.publishRaw(envelope.type, envelope);

    expect(outcome).toBe('processed');
    expect(pickups.records[0]).toMatchObject({ status: 'address_review', warehouseId: 'WH-MISSING' });
  });

});
