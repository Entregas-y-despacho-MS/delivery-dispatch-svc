import { EventEmitter2 } from '@nestjs/event-emitter';
import { describe, expect, it, vi } from 'vitest';
import { RouteBatchApprovalConflictException } from '../exceptions/route-batch-approval-conflict.exception.js';
import { RouteBatchFinalApprovalService } from './route-batch-final-approval.service.js';
import { RouteBatchResourcesService } from './route-batch-resources.service.js';

function createHarness(options: { batchVersion?: number; batchStatus?: string; dispatches?: any[]; packageCount?: number } = {}) {
  const batch = {
    id: 12,
    version: options.batchVersion ?? 4,
    status: options.batchStatus ?? 'pending_final_review',
    shift_date: '2026-10-20',
    proposed_driver_id: 34,
    vehicle_id: 56,
    zone_name: 'Centro',
  };
  const dispatches = options.dispatches ?? [{
    id: 77,
    version: 2,
    status: 'scheduled',
    type: 'delivery',
    priority: 'urgent',
    source_order_ref: 'SO-77',
    delivery_address: 'Test address',
    delivery_latitude: '-16.5',
    delivery_longitude: '-68.1',
    scheduled_window_start: new Date('2026-10-20T13:00:00Z'),
    scheduled_window_end: new Date('2026-10-20T15:00:00Z'),
  }];
  let isTransactionActive = false;
  const manager = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM route_batches b') && sql.includes('FOR UPDATE OF b')) return [batch];
      if (sql.includes('JOIN dispatch_types')) return dispatches;
      if (sql.includes('COUNT(p.dispatch_package_id)')) return dispatches.map((dispatch) => ({ dispatch_id: dispatch.id, package_count: String(options.packageCount ?? 1) }));
      if (sql.includes('source_order_ref = ANY')) return [];
      if (sql.includes('FROM vehicles v JOIN vehicle_statuses')) return [{ id: batch.vehicle_id }];
      if (sql.includes('FROM users u JOIN roles')) return [{ id: batch.proposed_driver_id }];
      if (sql.includes('route_batch_id <> $1')) return [];
      if (sql.includes('UPDATE route_batches')) return [{ version: batch.version + 1 }];
      if (sql.includes('UPDATE dispatches')) return [{ dispatch_id: dispatches[0]?.id }];
      return [];
    }),
  };
  const runner = {
    manager,
    connect: vi.fn(),
    startTransaction: vi.fn(async () => { isTransactionActive = true; }),
    commitTransaction: vi.fn(async () => { isTransactionActive = false; }),
    rollbackTransaction: vi.fn(async () => { isTransactionActive = false; }),
    release: vi.fn(),
    get isTransactionActive() { return isTransactionActive; },
  };
  const dataSource = { createQueryRunner: vi.fn(() => runner) };
  const capacity = { assertAssignable: vi.fn().mockResolvedValue({ assignable: true }) };
  const events = { emit: vi.fn() };
  const service = new RouteBatchFinalApprovalService(dataSource as any, capacity as any, events as unknown as EventEmitter2, new RouteBatchResourcesService());
  return { service, runner, manager, capacity, events };
}

describe('RouteBatchFinalApprovalService', () => {
  it('confirms the batch and dispatches in one transaction, then emits route.assigned', async () => {
    const { service, runner, manager, capacity, events } = createHarness();

    await expect(service.approve(12, { version: 4, dispatches: [{ dispatchId: 77, version: 2 }] }, 9))
      .resolves.toEqual({ routeBatchId: 12, version: 5, driverId: 34, vehicleId: 56, dispatchIds: [77] });

    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining("SET status = $3, driver_id = $4"), expect.any(Array));
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining("VALUES ($1, 'assigned'"), expect.any(Array));
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining("VALUES ($1, 'final_approved'"), expect.any(Array));
    expect(capacity.assertAssignable).toHaveBeenCalledWith(12, 56, runner.manager);
    expect(runner.commitTransaction.mock.invocationCallOrder[0]).toBeLessThan(events.emit.mock.invocationCallOrder[0]);
    expect(events.emit).toHaveBeenCalledWith('route.assigned', {
      routeId: 12,
      driverId: 34,
      vehicleId: 56,
      dispatchIds: [77],
      dispatches: [{ dispatchId: 77, priority: 'urgent' }],
      zoneName: 'Centro',
      version: 5,
    });
  });

  it('emits the approved dispatch and priority snapshot in the event order', async () => {
    const dispatches = [
      {
        id: 77,
        version: 2,
        status: 'scheduled',
        type: 'delivery',
        priority: 'normal',
        source_order_ref: 'SO-77',
        delivery_address: 'First stop',
        delivery_latitude: '-16.5',
        delivery_longitude: '-68.1',
        scheduled_window_start: new Date('2026-10-20T13:00:00Z'),
        scheduled_window_end: new Date('2026-10-20T15:00:00Z'),
      },
      {
        id: 78,
        version: 3,
        status: 'scheduled',
        type: 'delivery',
        priority: 'urgent',
        source_order_ref: 'SO-78',
        delivery_address: 'Second stop',
        delivery_latitude: '-16.4',
        delivery_longitude: '-68.0',
        scheduled_window_start: new Date('2026-10-20T15:00:00Z'),
        scheduled_window_end: new Date('2026-10-20T17:00:00Z'),
      },
    ];
    const { service, events } = createHarness({ dispatches });

    await service.approve(12, {
      version: 4,
      dispatches: [{ dispatchId: 77, version: 2 }, { dispatchId: 78, version: 3 }],
    }, 9);

    expect(events.emit).toHaveBeenCalledWith('route.assigned', expect.objectContaining({
      dispatchIds: [77, 78],
      dispatches: [{ dispatchId: 77, priority: 'normal' }, { dispatchId: 78, priority: 'urgent' }],
      zoneName: 'Centro',
    }));
  });

  it('rejects a stale batch version and rolls back without emitting', async () => {
    const { service, runner, events } = createHarness({ batchVersion: 5 });

    await expect(service.approve(12, { version: 4, dispatches: [{ dispatchId: 77, version: 2 }] }, 9))
      .rejects.toBeInstanceOf(RouteBatchApprovalConflictException);

    expect(runner.rollbackTransaction).toHaveBeenCalledOnce();
    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('rejects an unvalidated batch before changing assignments', async () => {
    const { service, runner, manager, events } = createHarness({ batchStatus: 'provisional' });

    await expect(service.approve(12, { version: 4, dispatches: [{ dispatchId: 77, version: 2 }] }, 9))
      .rejects.toMatchObject({ response: { error: 'ROUTE_BATCH_NOT_PENDING_FINAL_REVIEW' } });

    expect(manager.query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE route_batches'), expect.anything());
    expect(runner.rollbackTransaction).toHaveBeenCalledOnce();
    expect(events.emit).not.toHaveBeenCalled();
  });
});
