import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import type { MessageHandler } from '../../../../plugins/messaging/message-bus.port.js';
import { RejectedMessageException } from '../../../../plugins/messaging/exceptions/rejected-message.exception.js';
import {
  ProcurementPickupConsumer,
  PROCUREMENT_PICKUP_TOPICS,
} from './procurement-pickup-consumer.service.js';

const ORDER = 'PO-2026-000087';
const requested = {
  purchaseOrderId: ORDER,
  recordVersion: 1,
  updatedAt: '2026-10-12T14:00:00Z',
  supplier: { supplierId: 'SUP-1', name: 'Proveedor Uno' },
  products: [{ productId: 'SKU-1', quantity: 2 }],
};

function envelope(
  type: string,
  data: Record<string, unknown>,
  messageId = '0199f8c0-0000-7000-8000-000000000001',
): MessageEnvelope {
  return {
    messageId,
    type,
    source: 'procurement',
    schemaVersion: 1,
    occurredAt: '2026-10-12T14:00:00Z',
    data,
  };
}

describe('ProcurementPickupConsumer', () => {
  const handlers = new Map<string, MessageHandler>();
  const bus = {
    subscribe: vi.fn(async (topic: string, handler: MessageHandler) => {
      handlers.set(topic, handler);
    }),
  };
  const transaction = {
    process: vi.fn(
      async (
        _envelope: MessageEnvelope,
        _id: string,
        handle: (options: object) => Promise<void>,
      ) => {
        await handle({ manager: {} });
        return 'receipt-committed' as const;
      },
    ),
  };
  const syncStates = {
    find: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
  };
  const pickups = {
    applyRequested: vi.fn().mockResolvedValue(undefined),
    applyUpdated: vi.fn().mockResolvedValue(undefined),
    applyCancelled: vi.fn().mockResolvedValue(undefined),
  };
  const events = { emitAfterCommit: vi.fn() };
  let consumer: ProcurementPickupConsumer;

  const send = async (
    type: string,
    data: Record<string, unknown>,
    messageId?: string,
  ) => {
    const handler = handlers.get(type);
    expect(handler).toBeDefined();
    return await handler!(envelope(type, data, messageId));
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    handlers.clear();
    syncStates.find.mockResolvedValue(null);
    transaction.process.mockImplementation(async (_message, _id, handle) => {
      await handle({ manager: {} });
      return 'receipt-committed';
    });
    consumer = new ProcurementPickupConsumer(
      bus as never,
      transaction as never,
      syncStates as never,
      pickups as never,
      events as never,
    );
    await consumer.onModuleInit();
  });

  it('subscribes to request, update and cancellation topics', () => {
    expect([...handlers.keys()]).toEqual(
      Object.values(PROCUREMENT_PICKUP_TOPICS),
    );
  });

  it('creates a supplier pickup and records its procurement version atomically', async () => {
    await send(PROCUREMENT_PICKUP_TOPICS.requested, requested);

    expect(transaction.process).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROCUREMENT_PICKUP_TOPICS.requested }),
      ORDER,
      expect.any(Function),
    );
    expect(pickups.applyRequested).toHaveBeenCalledWith(requested, {
      manager: {},
    });
    expect(syncStates.save).toHaveBeenCalledWith(
      {
        salesOrderId: ORDER,
        source: 'procurement',
        lastRecordVersion: 1,
        baseReceived: true,
        cancelledAt: null,
        cancelledVersion: null,
      },
      { manager: {} },
    );
  });

  it('applies only newer updates after the request exists', async () => {
    syncStates.find.mockResolvedValue({
      salesOrderId: ORDER,
      source: 'procurement',
      lastRecordVersion: 1,
      baseReceived: true,
      cancelledAt: null,
      cancelledVersion: null,
    });
    const update = {
      purchaseOrderId: ORDER,
      recordVersion: 2,
      updatedAt: '2026-10-12T15:00:00Z',
      pickupWindow: {
        startsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        endsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      },
    };

    await send(PROCUREMENT_PICKUP_TOPICS.updated, update);

    expect(pickups.applyUpdated).toHaveBeenCalledWith(update, { manager: {} });
    expect(syncStates.save).toHaveBeenCalledWith(
      expect.objectContaining({ lastRecordVersion: 2 }),
      { manager: {} },
    );
  });

  it('does not let a late request resurrect a cancelled purchase order', async () => {
    syncStates.find.mockResolvedValue({
      salesOrderId: ORDER,
      source: 'procurement',
      lastRecordVersion: 2,
      baseReceived: false,
      cancelledAt: '2026-10-12T15:00:00.000Z',
      cancelledVersion: 2,
    });

    await send(PROCUREMENT_PICKUP_TOPICS.requested, requested);

    expect(pickups.applyRequested).not.toHaveBeenCalled();
    expect(syncStates.save).not.toHaveBeenCalled();
  });

  it('ignores an update until its base request has arrived', async () => {
    const update = {
      purchaseOrderId: ORDER,
      recordVersion: 2,
      updatedAt: '2026-10-12T15:00:00Z',
      products: [],
    };

    await send(PROCUREMENT_PICKUP_TOPICS.updated, update);

    expect(pickups.applyUpdated).not.toHaveBeenCalled();
  });

  it('rejects past pickup windows before writing anything so the message pipeline can dead-letter them', async () => {
    const pastRequest = {
      ...requested,
      pickupWindow: {
        startsAt: '2000-01-01T13:00:00Z',
        endsAt: '2000-01-01T18:00:00Z',
      },
    };

    await expect(
      send(PROCUREMENT_PICKUP_TOPICS.requested, pastRequest),
    ).rejects.toBeInstanceOf(RejectedMessageException);

    expect(transaction.process).not.toHaveBeenCalled();
    expect(pickups.applyRequested).not.toHaveBeenCalled();
  });

  it('emits coordinator attention only after the transactional handler finishes', async () => {
    syncStates.find.mockResolvedValue({
      salesOrderId: ORDER,
      source: 'procurement',
      lastRecordVersion: 1,
      baseReceived: true,
      cancelledAt: null,
      cancelledVersion: null,
    });
    pickups.applyCancelled.mockResolvedValue({
      status: 'attention_required',
      dispatchId: 42,
      event: {
        dispatchId: 42,
        source: 'procurement',
        changeType: 'order_cancelled',
        receivedAt: '2026-10-12T16:00:00Z',
      },
    });

    await send(PROCUREMENT_PICKUP_TOPICS.cancelled, {
      purchaseOrderId: ORDER,
      recordVersion: 2,
      updatedAt: '2026-10-12T16:00:00Z',
      cancelledAt: '2026-10-12T16:00:00Z',
    });

    expect(events.emitAfterCommit).toHaveBeenCalledWith([
      expect.objectContaining({ status: 'attention_required', dispatchId: 42 }),
    ]);
  });
});
