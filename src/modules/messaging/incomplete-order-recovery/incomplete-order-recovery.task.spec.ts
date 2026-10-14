import { EventEmitter2 } from '@nestjs/event-emitter';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../plugins/messaging/envelope/uuid-v7.js', () => ({
  generateMessageId: () => '0192fbe5-f6cc-7fcc-9bff-2d8cae4a6edc',
}));

import { DISPATCH_CHANGE_REQUIRES_ATTENTION } from '../sales-order-intake/services/dispatch-change-events.service.js';
import { MemoryMessageBusAdapter } from '../../../plugins/messaging/memory/memory-message-bus.adapter.js';
import { MemoryInboundMessageLogAdapter } from '../../../plugins/messaging/memory/memory-inbound-message-log.adapter.js';
import { MessageValidator } from '../../../plugins/messaging/envelope/message-validator.js';
import { IncompleteOrderRecoveryTask } from './incomplete-order-recovery.task.js';

interface State {
  sync_attempts: number;
  last_sync_requested_at: Date | null;
  incomplete_alerted_at: Date | null;
  base_received: boolean;
  cancelled_at: Date | null;
}

function setup(
  initial: Partial<State> = {},
  candidateOverrides: Partial<{
    sales_order_id: string;
    source: 'marketplace' | 'inventory';
    entity_type: 'sales_order' | 'shipment';
    observed_at: Date | string;
  }> = {},
  otherOriginCancelled = false,
) {
  const state: State = {
    sync_attempts: 0,
    last_sync_requested_at: null,
    incomplete_alerted_at: null,
    base_received: false,
    cancelled_at: null,
    ...initial,
  };
  const candidate = {
    sales_order_id: 'SO-50-5',
    source: 'inventory' as const,
    entity_type: 'shipment' as const,
    observed_at: new Date('2026-10-14T10:00:00.000Z'),
    ...candidateOverrides,
  };
  const manager = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO sales_order_sync_states')) return [];
      if (sql.includes('SELECT source, sync_attempts')) {
        const otherSource: State & { source: 'marketplace' } = {
          sync_attempts: 0,
          last_sync_requested_at: null,
          incomplete_alerted_at: null,
          base_received: false,
          cancelled_at: null,
          ...(otherOriginCancelled ? { cancelled_at: new Date() } : {}),
          source: 'marketplace',
        };
        return candidate.source === 'inventory'
          ? [{ source: candidate.source, ...state }, otherSource]
          : [{ source: candidate.source, ...state }];
      }
      if (sql.includes('SET sync_attempts')) {
        state.sync_attempts = params[2] as number;
        state.last_sync_requested_at = params[3] as Date;
        return [];
      }
      if (sql.includes('SET incomplete_alerted_at = NULL')) {
        state.incomplete_alerted_at = null;
        return [];
      }
      if (sql.includes('SET incomplete_alerted_at')) {
        state.incomplete_alerted_at = params[2] as Date;
        return [];
      }
      throw new Error(`Unexpected query: ${sql}`);
    }),
  };
  const dataSource = {
    query: vi.fn(async () => [candidate]),
    transaction: vi.fn(
      async (callback: (value: unknown) => Promise<unknown>) =>
        await callback(manager),
    ),
  };
  const settings = {
    getNumber: vi.fn(async (_key: string, fallback: number) => fallback),
  };
  const validator = MessageValidator.fromDirectory();
  const bus = new MemoryMessageBusAdapter(
    validator,
    new MemoryInboundMessageLogAdapter(),
  );
  const events = new EventEmitter2();
  const registry = { register: vi.fn() };
  const task = new IncompleteOrderRecoveryTask(
    dataSource as never,
    settings as never,
    bus,
    events,
    registry as never,
  );

  return { task, bus, events, registry, state, dataSource, settings };
}

describe('IncompleteOrderRecoveryTask', () => {
  it('registers a shared scheduler task that runs every 15 minutes', () => {
    const { task, registry } = setup();

    task.onModuleInit();

    expect(registry.register).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'incomplete-order-recovery',
        schedule: { kind: 'every-minutes', minutes: 15 },
      }),
    );
  });

  it('publishes the missing origin request and alerts after the third spaced request', async () => {
    const { task, bus, events, state, settings } = setup();
    const alerts: unknown[] = [];
    events.on(DISPATCH_CHANGE_REQUIRES_ATTENTION, (alert) =>
      alerts.push(alert),
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await task.recover(new Date(Date.UTC(2026, 9, 14, 10, attempt * 15)));
    }

    const messages = bus.publishedTo('dispatch.sync.requested') as Array<{
      data: Record<string, unknown>;
    }>;
    expect(messages.map(({ data }) => data)).toEqual([
      expect.objectContaining({
        entityType: 'shipment',
        entityId: 'SO-50-5',
        attempt: 1,
      }),
      expect.objectContaining({
        entityType: 'shipment',
        entityId: 'SO-50-5',
        attempt: 2,
      }),
      expect.objectContaining({
        entityType: 'shipment',
        entityId: 'SO-50-5',
        attempt: 3,
      }),
    ]);
    expect(messages.every((message) => message.data.requestedAt)).toBe(true);
    expect(state.sync_attempts).toBe(3);
    expect(alerts).toEqual([
      expect.objectContaining({
        salesOrderId: 'SO-50-5',
        source: 'inventory',
        changeType: 'incomplete_order',
      }),
    ]);
    expect(settings.getNumber).toHaveBeenCalledWith(
      'incomplete_order_alert_minutes',
      60,
    );

    await task.recover(new Date('2026-10-14T11:00:00.000Z'));
    expect(bus.publishedTo('dispatch.sync.requested')).toHaveLength(3);
    expect(alerts).toHaveLength(1);
  });

  it('does not publish or alert when the missing origin arrives before the next run', async () => {
    const { task, bus, events, state } = setup({ base_received: true });
    const alert = vi.fn();
    events.on(DISPATCH_CHANGE_REQUIRES_ATTENTION, alert);

    await task.recover(new Date('2026-10-14T10:00:00.000Z'));

    expect(bus.publishedTo('dispatch.sync.requested')).toHaveLength(0);
    expect(alert).not.toHaveBeenCalled();
    expect(state.sync_attempts).toBe(0);
  });

  it('routes a missing sales order record to Marketplace', async () => {
    const { task, bus } = setup(
      {},
      { source: 'marketplace', entity_type: 'sales_order' },
    );

    await task.recover(new Date('2026-10-14T10:00:00.000Z'));

    expect(bus.publishedTo('dispatch.sync.requested')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          entityType: 'sales_order',
          entityId: 'SO-50-5',
          attempt: 1,
        }),
      }),
    ]);
  });

  it('does not request recovery after the available origin has cancelled the order', async () => {
    const { task, bus, state } = setup({}, {}, true);

    await task.recover(new Date('2026-10-14T10:00:00.000Z'));

    expect(bus.publishedTo('dispatch.sync.requested')).toHaveLength(0);
    expect(state.sync_attempts).toBe(0);
  });

  it('retries the alert when no listener accepted the event', async () => {
    const { task, state } = setup({ sync_attempts: 3 });
    const emit = vi.spyOn(EventEmitter2.prototype, 'emit').mockReturnValue(false);

    await task.recover(new Date('2026-10-14T11:00:00.000Z'));

    expect(state.incomplete_alerted_at).toBeNull();
    expect(emit).toHaveBeenCalledWith(
      DISPATCH_CHANGE_REQUIRES_ATTENTION,
      expect.objectContaining({ changeType: 'incomplete_order' }),
    );
    emit.mockRestore();
  });

  it('retries the alert when a listener throws', async () => {
    const { task, state, events } = setup({ sync_attempts: 3 });
    events.on(DISPATCH_CHANGE_REQUIRES_ATTENTION, () => {
      throw new Error('listener failed');
    });

    await task.recover(new Date('2026-10-14T11:00:00.000Z'));

    expect(state.incomplete_alerted_at).toBeNull();
  });
});
