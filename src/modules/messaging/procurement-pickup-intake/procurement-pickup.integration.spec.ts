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
import {
  OrderSyncStatePort,
  type OrderSyncState,
  type OrderSyncSource,
} from '../sales-order-sync/ports/order-sync-state.port.js';
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

class MemoryPickupRepository
  extends ProcurementPickupRepository
  implements MemoryTransactionParticipant<PickupRecord[]>
{
  // This double isolates the consumer/message circuit; it does not exercise the SQL or business
  // rules in ProcurementPickupRepository. Those repository rules have separate integration specs.
  records: PickupRecord[] = [];

  snapshot(): PickupRecord[] {
    return structuredClone(this.records);
  }

  restore(snapshot: PickupRecord[]): void {
    this.records = snapshot;
  }

  async applyRequested(
    data: ProcurementPickupRequestedData,
    _options: TransactionOptions,
  ): Promise<null> {
    const existing = this.records.find(
      (record) => record.purchaseOrderId === data.purchaseOrderId,
    );
    const complete = Boolean(
      data.pickupAddress?.line &&
      data.pickupWindow &&
      data.warehouseId === 'WH-LPZ-01',
    );
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

  async applyUpdated(
    data: ProcurementPickupUpdatedData,
    _options: TransactionOptions,
  ): Promise<null> {
    const record = this.records.find(
      (item) => item.purchaseOrderId === data.purchaseOrderId,
    );
    if (!record) return null;
    if (data.pickupAddress) record.address = data.pickupAddress.line;
    if (data.pickupWindow)
      record.pickupWindow = structuredClone(data.pickupWindow);
    if (data.warehouseId !== undefined) record.warehouseId = data.warehouseId;
    if (data.estimates) record.weightKg = data.estimates.weightKg ?? null;
    if (data.products) record.products = structuredClone(data.products);
    if (record.status !== 'scheduled') {
      record.status =
        record.address &&
        record.pickupWindow &&
        record.warehouseId === 'WH-LPZ-01'
          ? 'pending'
          : 'address_review';
    }
    return null;
  }

  async applyCancelled(
    data: ProcurementPickupCancelledData,
    _options: TransactionOptions,
  ): Promise<null> {
    const record = this.records.find(
      (item) => item.purchaseOrderId === data.purchaseOrderId,
    );
    if (
      record &&
      ['pending', 'address_review', 'scheduled'].includes(record.status)
    )
      record.status = 'cancelled';
    return null;
  }
}

class MemoryOrderSyncState
  extends OrderSyncStatePort
  implements MemoryTransactionParticipant<Map<string, OrderSyncState>>
{
  private states = new Map<string, OrderSyncState>();

  snapshot(): Map<string, OrderSyncState> {
    return structuredClone(this.states);
  }

  restore(snapshot: Map<string, OrderSyncState>): void {
    this.states = snapshot;
  }

  async find(
    salesOrderId: string,
    source: OrderSyncSource,
  ): Promise<OrderSyncState | null> {
    return this.states.get(`${salesOrderId}:${source}`) ?? null;
  }

  async findAllOf(salesOrderId: string): Promise<OrderSyncState[]> {
    return [...this.states.values()].filter(
      (state) => state.salesOrderId === salesOrderId,
    );
  }

  async save(state: OrderSyncState): Promise<void> {
    this.states.set(
      `${state.salesOrderId}:${state.source}`,
      structuredClone(state),
    );
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

function message(
  type: string,
  data: Record<string, unknown>,
  messageId = generateMessageId(),
): MessageEnvelope {
  return {
    messageId,
    type,
    source: 'procurement',
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    data,
  };
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
  const events = {
    emitAfterCommit: vi.fn(),
  } as unknown as DispatchChangeEvents;
  const consumer = new ProcurementPickupConsumer(
    bus,
    transaction,
    syncStates,
    pickups,
    events,
  );
  return { bus, pickups, syncStates, consumer };
}

describe('Procurement pickup messaging integration', () => {
  it('consumes a valid request and creates a pending supplier pickup', async () => {
    const { bus, pickups, consumer } = buildConsumerCircuit();
    await consumer.onModuleInit();
    const envelope = message('procurement.pickup.requested', pickupRequest());

    const outcome = await bus.publishRaw(envelope.type, envelope);

    expect(outcome).toBe('processed');
    expect(pickups.records).toHaveLength(1);
    expect(pickups.records[0]).toMatchObject({
      type: 'supplier_pickup',
      status: 'pending',
      purchaseOrderId: ORDER_ID,
      address: 'Av. Industrial 123',
      warehouseId: 'WH-LPZ-01',
      products: [{ productId: 'SKU-1', quantity: 2 }],
    });
  });

  it('retains an incomplete request for address review when its warehouse is unknown', async () => {
    const { bus, pickups, consumer } = buildConsumerCircuit();
    await consumer.onModuleInit();
    const envelope = message(
      'procurement.pickup.requested',
      pickupRequest({ warehouseId: 'WH-MISSING' }),
    );

    const outcome = await bus.publishRaw(envelope.type, envelope);

    expect(outcome).toBe('processed');
    expect(pickups.records[0]).toMatchObject({
      status: 'address_review',
      warehouseId: 'WH-MISSING',
    });
  });

  it('applies a newer update and cancellation while the pickup is pending', async () => {
    const { bus, pickups, syncStates, consumer } = buildConsumerCircuit();
    await consumer.onModuleInit();
    const requested = message('procurement.pickup.requested', pickupRequest());
    await bus.publishRaw(requested.type, requested);

    const updated = message('procurement.pickup.updated', {
      purchaseOrderId: ORDER_ID,
      recordVersion: 2,
      updatedAt: new Date().toISOString(),
      estimates: { packages: 3, weightKg: 550, volumeM3: 4 },
    });
    expect(await bus.publishRaw(updated.type, updated)).toBe('processed');
    expect(pickups.records[0]).toMatchObject({
      status: 'pending',
      weightKg: 550,
    });
    expect(await syncStates.find(ORDER_ID, 'procurement')).toMatchObject({
      lastRecordVersion: 2,
    });

    const cancelledAt = new Date().toISOString();
    const cancelled = message('procurement.pickup.cancelled', {
      purchaseOrderId: ORDER_ID,
      recordVersion: 3,
      updatedAt: cancelledAt,
      cancelledAt,
      reason: 'Orden cancelada por Compras',
    });
    expect(await bus.publishRaw(cancelled.type, cancelled)).toBe('processed');
    expect(pickups.records[0].status).toBe('cancelled');
    expect(await syncStates.find(ORDER_ID, 'procurement')).toMatchObject({
      lastRecordVersion: 3,
      cancelledAt,
    });
  });

  it.each([
    { kind: 'requested', version: 2 },
    { kind: 'requested', version: 3 },
    { kind: 'updated', version: 2 },
    { kind: 'updated', version: 3 },
    { kind: 'cancelled', version: 2 },
    { kind: 'cancelled', version: 3 },
  ] as const)(
    'ignores a $kind message at recordVersion $version when the last applied version is 3',
    async ({ kind, version }) => {
      const { bus, pickups, syncStates, consumer } = buildConsumerCircuit();
      await consumer.onModuleInit();
      await syncStates.save({
        salesOrderId: ORDER_ID,
        source: 'procurement',
        lastRecordVersion: 3,
        baseReceived: true,
        cancelledAt: null,
        cancelledVersion: null,
      });

      const updatedAt = new Date().toISOString();
      const type = `procurement.pickup.${kind}`;
      const data =
        kind === 'requested'
          ? pickupRequest({ recordVersion: version })
          : kind === 'updated'
            ? {
                purchaseOrderId: ORDER_ID,
                recordVersion: version,
                updatedAt,
                estimates: { weightKg: 900 },
              }
            : {
                purchaseOrderId: ORDER_ID,
                recordVersion: version,
                updatedAt,
                cancelledAt: updatedAt,
                reason: 'Cancelación tardía',
              };

      expect(await bus.publishRaw(type, message(type, data))).toBe('processed');
      expect(pickups.records).toHaveLength(0);
      expect(await syncStates.find(ORDER_ID, 'procurement')).toMatchObject({
        lastRecordVersion: 3,
        cancelledAt: null,
      });
    },
  );

  it('ignores a requested message received after that purchase order was cancelled', async () => {
    const { bus, pickups, syncStates, consumer } = buildConsumerCircuit();
    await consumer.onModuleInit();
    const cancelledAt = new Date().toISOString();
    await syncStates.save({
      salesOrderId: ORDER_ID,
      source: 'procurement',
      lastRecordVersion: 2,
      baseReceived: true,
      cancelledAt,
      cancelledVersion: 2,
    });
    const requested = message(
      'procurement.pickup.requested',
      pickupRequest({ recordVersion: 3 }),
    );

    expect(await bus.publishRaw(requested.type, requested)).toBe('processed');
    expect(pickups.records).toHaveLength(0);
    expect(await syncStates.find(ORDER_ID, 'procurement')).toMatchObject({
      lastRecordVersion: 2,
      cancelledAt,
    });
  });

  it('ignores an update when the base request has not been received', async () => {
    const { bus, pickups, syncStates, consumer } = buildConsumerCircuit();
    await consumer.onModuleInit();
    await syncStates.save({
      salesOrderId: ORDER_ID,
      source: 'procurement',
      lastRecordVersion: 0,
      baseReceived: false,
      cancelledAt: null,
      cancelledVersion: null,
    });
    const updated = message('procurement.pickup.updated', {
      purchaseOrderId: ORDER_ID,
      recordVersion: 1,
      updatedAt: new Date().toISOString(),
      estimates: { weightKg: 900 },
    });

    expect(await bus.publishRaw(updated.type, updated)).toBe('processed');
    expect(pickups.records).toHaveLength(0);
    expect(await syncStates.find(ORDER_ID, 'procurement')).toMatchObject({
      lastRecordVersion: 0,
      baseReceived: false,
    });
  });

  it('dead-letters an invalid request without creating a pickup', async () => {
    const { bus, pickups, consumer } = buildConsumerCircuit();
    await consumer.onModuleInit();
    const invalid = message('procurement.pickup.requested', {
      purchaseOrderId: ORDER_ID,
      recordVersion: 1,
    });

    const outcome = await bus.publishRaw(invalid.type, invalid);

    expect(outcome).toBe('rejected');
    expect(bus.deadLettersOf(invalid.type)).toHaveLength(1);
    expect(pickups.records).toHaveLength(0);
  });

  it('does not create a second pickup when Pub/Sub redelivers the same messageId', async () => {
    const { bus, pickups, consumer } = buildConsumerCircuit();
    await consumer.onModuleInit();
    const envelope = message('procurement.pickup.requested', pickupRequest());

    expect(await bus.publishRaw(envelope.type, envelope)).toBe('processed');
    expect(await bus.publishRaw(envelope.type, envelope)).toBe('duplicate');
    expect(pickups.records).toHaveLength(1);
  });
});

const SCHEDULE_NOW = new Date('2026-10-19T00:00:00Z');

function scheduleCircuit() {
  const log = new MemoryInboundMessageLogAdapter();
  const validator = MessageValidator.fromDirectory(CONTRACTS_DIR);
  const bus = new MemoryMessageBusAdapter(validator, log);
  const savedEvents: Array<Record<string, unknown>> = [];
  const row: Record<string, unknown> = {
    dispatch_id: 7,
    type: 'supplier_pickup',
    status: 'pending',
    source_order_ref: ORDER_ID,
    delivery_address: 'Av. Industrial 123',
    destination_warehouse_id: 1,
    warehouse_id: 1,
    scheduled_window_start: new Date('2026-10-20T13:00:00Z'),
    scheduled_window_end: new Date('2026-10-20T20:00:00Z'),
    estimated_weight_kg: '400.00',
    estimated_volume_m3: '3.000',
    tracking_code: null,
    reception_start_time: '08:00:00',
    reception_end_time: '12:00:00',
  };
  const manager = {
    // SQL-fragment routing keeps this query double explicit and fails closed when the service adds a query.
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FOR UPDATE OF d')) return [{ ...row }];
      if (sql.includes('FROM vehicles'))
        return [{ capacity_kg: '1000', capacity_m3: '8' }];
      if (sql.includes('FROM dispatch_events')) {
        return savedEvents
          .filter((event) =>
            ['pickup_scheduled', 'pickup_rescheduled'].includes(
              String(event.eventType),
            ),
          )
          .map((event) => ({
            version: String(
              (event.metadata as Record<string, unknown>).recordVersion,
            ),
          }));
      }
      if (sql.includes('INSERT INTO dispatch_events')) {
        savedEvents.push({
          eventType: params[1],
          metadata: JSON.parse(params[5] as string),
        });
        return [];
      }
      if (sql.includes('FROM incident_reasons'))
        return [{ code: 'INC-COMP-FAILURE' }];
      if (sql.includes('FROM reschedule_reasons'))
        return [{ code: 'RES-OPS-SUPPLIER' }];
      if (
        sql.includes('INSERT INTO dispatch_incidents') ||
        sql.includes('INSERT INTO dispatch_reschedules')
      )
        return [];
      if (sql.includes('UPDATE dispatches')) {
        if (isInitialScheduleUpdate(params)) {
          row.status = params[0];
          row.scheduled_window_start = params[1];
          row.scheduled_window_end = params[2];
        } else {
          row.scheduled_window_start = params[0];
          row.scheduled_window_end = params[1];
        }
        row.tracking_code = 'DSP-2026-00051';
        return [{ tracking_code: 'DSP-2026-00051' }];
      }
      throw new Error(`Unexpected scheduling query: ${sql}`);
    }),
  };
  const dataSource = {
    transaction: async (callback: (manager: unknown) => unknown) =>
      await callback(manager),
  };
  const settings = {
    getString: vi.fn(async (_key: string, fallback: string) => fallback),
    getNumber: vi.fn(async () => 2),
  };
  const outbox = {
    enqueue: vi.fn(async (envelope: MessageEnvelope) => {
      expect(validator.validate(envelope.type, envelope)).toEqual({
        valid: true,
      });
      await bus.publish(envelope.type, envelope);
      return true;
    }),
  };
  const service = new PickupSchedulingService(
    dataSource as never,
    settings as never,
    outbox as never,
  );
  return { service, bus, outbox, savedEvents, manager, row };
}

/** schedule() binds a status name first; reschedule() binds the new start time first. */
function isInitialScheduleUpdate(params: unknown[]): boolean {
  return typeof params[0] === 'string';
}

describe('supplier pickup scheduling message integration', () => {
  it('publishes the scheduled pickup over the validated memory bus', async () => {
    const { service, bus, outbox } = scheduleCircuit();

    const result = await service.schedule(7, { vehicleId: 3 }, 9, SCHEDULE_NOW);

    expect(result.recordVersion).toBe(1);
    expect(outbox.enqueue).toHaveBeenCalledOnce();
    expect(bus.publishedTo('dispatch.pickup.scheduled')[0]).toMatchObject({
      type: 'dispatch.pickup.scheduled',
      source: 'dispatch',
      data: { purchaseOrderId: ORDER_ID, recordVersion: 1 },
    });
  });

  it('publishes scheduling and rescheduling messages with consecutive recordVersions', async () => {
    const { service, bus, outbox, row } = scheduleCircuit();
    await service.schedule(7, { vehicleId: 3 }, 9, SCHEDULE_NOW);
    await service.reschedule(
      7,
      {
        incidentReasonId: 4,
        rescheduleReasonId: 6,
        window: {
          startsAt: new Date('2026-10-21T13:00:00Z'),
          endsAt: new Date('2026-10-21T15:00:00Z'),
        },
      },
      9,
      SCHEDULE_NOW,
    );

    const scheduledMessages = bus.publishedTo(
      'dispatch.pickup.scheduled',
    ) as Array<
      MessageEnvelope<{
        recordVersion: number;
        pickupWindow: { startsAt: string };
      }>
    >;
    const outboxMessages = outbox.enqueue.mock.calls.map(
      ([envelope]) => envelope,
    );
    expect(outbox.enqueue).toHaveBeenCalledTimes(3);
    expect(outboxMessages.map(({ type }) => type)).toEqual([
      'dispatch.pickup.scheduled',
      'dispatch.transfer.incident_reported',
      'dispatch.pickup.scheduled',
    ]);
    expect(outboxMessages.map(({ data }) => data.recordVersion)).toEqual([
      1, 2, 2,
    ]);
    expect(scheduledMessages).toHaveLength(2);
    expect(scheduledMessages.map(({ data }) => data.recordVersion)).toEqual([
      1, 2,
    ]);
    expect(scheduledMessages[1].data.pickupWindow.startsAt).toBe(
      '2026-10-21T13:00:00.000Z',
    );
    expect(row.scheduled_window_start).toEqual(
      new Date('2026-10-21T13:00:00Z'),
    );
  });
});
