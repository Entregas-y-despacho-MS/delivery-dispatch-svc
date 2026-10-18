import { ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, QueryRunner } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DISPATCH_STATUS_CHANGED_EVENT } from '../../../../app/dispatch-status/dispatch-status-changed.event.js';
import {
  DispatchStatusEnum,
  RouteBatchStatusEnum,
} from '../../../../shared/enums/index.js';
import { OutboxService } from '../../../messaging/outbound-messages/services/outbox.service.js';
import { RouteBatchStartConflictException } from '../exceptions/route-batch-start-conflict.exception.js';
import { RouteBatchStartService } from './route-batch-start.service.js';

const eventId = '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10';
const savedAt = new Date('2026-10-18T12:00:00.000Z');
const dispatches = [
  {
    id: 21,
    version: 3,
    status: DispatchStatusEnum.ASSIGNED,
    source_order_ref: 'SO-21',
    tracking_code: 'DSP-00021',
  },
  {
    id: 22,
    version: 4,
    status: DispatchStatusEnum.ASSIGNED,
    source_order_ref: 'SO-22',
    tracking_code: 'DSP-00022',
  },
];

function setup(
  options: {
    batch?: { id: number; status: string; driver_id: number | null }[];
    prior?: {
      route_batch_id: number;
      metadata: { dispatchIds: number[]; startedAt: string };
    }[];
    dispatches?: typeof dispatches;
    packages?: { dispatch_id: number; external_package_id: string }[];
    outboxFailure?: Error;
  } = {},
) {
  const state = {
    batch: options.batch ?? [
      { id: 7, status: RouteBatchStatusEnum.CONFIRMED, driver_id: 9 },
    ],
    prior: options.prior ?? [],
    dispatches: options.dispatches ?? dispatches,
    packages: options.packages ?? [
      { dispatch_id: 21, external_package_id: 'PKG-21-A' },
      { dispatch_id: 22, external_package_id: 'PKG-22-A' },
      { dispatch_id: 22, external_package_id: 'PKG-22-B' },
    ],
  };
  const manager = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM route_batches')) return state.batch;
      if (sql.includes("metadata->>'eventId'")) return state.prior;
      if (sql.includes('FROM dispatches d')) return state.dispatches;
      if (sql.includes('FROM dispatch_packages')) return state.packages;
      if (sql.includes('UPDATE route_batches'))
        return [{ updated_at: savedAt }];
      if (sql.includes('UPDATE dispatches')) return [{ updated_at: savedAt }];
      return [];
    }),
  };
  const runner = {
    manager,
    isTransactionActive: false,
    connect: vi.fn().mockResolvedValue(undefined),
    startTransaction: vi.fn(async () => {
      runner.isTransactionActive = true;
    }),
    commitTransaction: vi.fn(async () => {
      runner.isTransactionActive = false;
    }),
    rollbackTransaction: vi.fn(async () => {
      runner.isTransactionActive = false;
    }),
    release: vi.fn().mockResolvedValue(undefined),
  } as unknown as QueryRunner;
  const dataSource = {
    createQueryRunner: vi.fn(() => runner),
  } as unknown as DataSource;
  const outbox = {
    enqueue: vi.fn(async () => {
      if (options.outboxFailure) throw options.outboxFailure;
      return true;
    }),
  } as unknown as OutboxService;
  const events = { emit: vi.fn() } as unknown as EventEmitter2;
  const service = new RouteBatchStartService(dataSource, outbox, events);
  return { service, manager, runner, outbox, events };
}

describe('RouteBatchStartService.start', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts the batch atomically, queues one departure per dispatch and emits changes after commit', async () => {
    const ctx = setup();
    const result = await ctx.service.start(7, { eventId }, 9);

    expect(result).toMatchObject({
      routeBatchId: 7,
      status: RouteBatchStatusEnum.IN_EXECUTION,
      dispatchIds: [21, 22],
    });
    expect(Date.parse(result.startedAt)).toBeGreaterThan(0);
    expect(ctx.runner.commitTransaction).toHaveBeenCalledOnce();
    expect(ctx.runner.rollbackTransaction).not.toHaveBeenCalled();
    expect(ctx.outbox.enqueue).toHaveBeenCalledTimes(2);
    const [message, options] = vi.mocked(ctx.outbox.enqueue).mock.calls[0];
    expect(message).toMatchObject({
      type: 'dispatch.shipment.departed',
      source: 'dispatch',
      data: {
        salesOrderId: 'SO-21',
        trackingCode: 'DSP-00021',
        recordVersion: 3,
        driverId: '9',
        packageIds: ['PKG-21-A'],
      },
    });
    expect(options?.manager).toBe(ctx.manager);
    expect(ctx.events.emit).toHaveBeenCalledTimes(2);
    expect(ctx.events.emit).toHaveBeenNthCalledWith(
      1,
      DISPATCH_STATUS_CHANGED_EVENT,
      expect.objectContaining({
        dispatchId: 21,
        previousStatus: DispatchStatusEnum.ASSIGNED,
        status: DispatchStatusEnum.OUT_FOR_DELIVERY,
      }),
    );
    expect(
      vi.mocked(ctx.runner.commitTransaction).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(ctx.events.emit).mock.invocationCallOrder[0]);
    const audit = ctx.manager.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO route_batch_events'),
    );
    expect(audit?.[0]).toContain('route_batch_events');
    expect(audit?.[1]?.[2]).toContain('PKG-22-B');
  });

  it('returns the original result for the same eventId without repeating writes', async () => {
    const startedAt = savedAt.toISOString();
    const ctx = setup({
      batch: [
        { id: 7, status: RouteBatchStatusEnum.IN_EXECUTION, driver_id: 9 },
      ],
      prior: [
        { route_batch_id: 7, metadata: { dispatchIds: [21, 22], startedAt } },
      ],
    });

    await expect(ctx.service.start(7, { eventId }, 9)).resolves.toEqual({
      routeBatchId: 7,
      status: RouteBatchStatusEnum.IN_EXECUTION,
      dispatchIds: [21, 22],
      startedAt,
    });
    expect(ctx.outbox.enqueue).not.toHaveBeenCalled();
    expect(ctx.events.emit).not.toHaveBeenCalled();
    expect(ctx.runner.commitTransaction).toHaveBeenCalledOnce();
  });

  it('rejects a non-confirmed batch without changing data', async () => {
    const ctx = setup({
      batch: [
        { id: 7, status: RouteBatchStatusEnum.PROVISIONAL, driver_id: 9 },
      ],
    });

    await expect(ctx.service.start(7, { eventId }, 9)).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'ROUTE_BATCH_NOT_CONFIRMED' }),
    });
    expect(ctx.outbox.enqueue).not.toHaveBeenCalled();
    expect(ctx.events.emit).not.toHaveBeenCalled();
    expect(ctx.runner.rollbackTransaction).toHaveBeenCalledOnce();
  });

  it('rejects a different driver with 403 before touching dispatches', async () => {
    const ctx = setup();

    await expect(ctx.service.start(7, { eventId }, 99)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(ctx.manager.query).toHaveBeenCalledTimes(1);
    expect(ctx.outbox.enqueue).not.toHaveBeenCalled();
    expect(ctx.events.emit).not.toHaveBeenCalled();
  });

  it('rejects a batch with an unassigned dispatch and queues no messages', async () => {
    const ctx = setup({
      dispatches: [
        { ...dispatches[0], status: DispatchStatusEnum.SCHEDULED },
        dispatches[1],
      ],
    });

    await expect(ctx.service.start(7, { eventId }, 9)).rejects.toBeInstanceOf(
      RouteBatchStartConflictException,
    );
    expect(ctx.outbox.enqueue).not.toHaveBeenCalled();
    expect(ctx.events.emit).not.toHaveBeenCalled();
  });

  it('rolls back state changes when outbox validation or persistence fails', async () => {
    const ctx = setup({
      outboxFailure: new Error('outbox rejected the contract'),
    });

    await expect(ctx.service.start(7, { eventId }, 9)).rejects.toThrow(
      'outbox rejected the contract',
    );
    expect(ctx.runner.rollbackTransaction).toHaveBeenCalledOnce();
    expect(ctx.events.emit).not.toHaveBeenCalled();
  });
});
