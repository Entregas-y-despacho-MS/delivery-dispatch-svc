import { describe, expect, it, vi } from 'vitest';
import { RouteBatchApprovalConflictException } from '../exceptions/route-batch-approval-conflict.exception.js';
import { RouteBatchResourcesService } from './route-batch-resources.service.js';

const service = new RouteBatchResourcesService();
const managerOf = (...answers: unknown[][]) => {
  const query = vi.fn();
  for (const answer of answers) query.mockResolvedValueOnce(answer);
  return { query } as any;
};
const codeOf = async (call: Promise<void>): Promise<string> => {
  const error = await call.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(RouteBatchApprovalConflictException);
  return (error as RouteBatchApprovalConflictException).getResponse()['error' as never];
};

describe('RouteBatchResourcesService', () => {
  it('accepts an active vehicle and rejects a missing or inactive one', async () => {
    await expect(service.assertVehicleActive(managerOf([{ id: 8 }]), 8)).resolves.toBeUndefined();
    expect(await codeOf(service.assertVehicleActive(managerOf([]), 8))).toBe('ROUTE_BATCH_VEHICLE_NOT_ACTIVE');
  });

  it('accepts a free active driver', async () => {
    await expect(service.assertDriverAvailable(managerOf([{ id: 34 }], []), 34, '2026-10-20', 12)).resolves.toBeUndefined();
  });

  it('rejects an inactive driver or one that is not a driver, without looking for conflicts', async () => {
    const manager = managerOf([]);
    expect(await codeOf(service.assertDriverAvailable(manager, 34, '2026-10-20', 12))).toBe('ROUTE_BATCH_DRIVER_NOT_AVAILABLE');
    expect(manager.query).toHaveBeenCalledTimes(1);
  });

  it('rejects a driver already assigned or proposed in another live batch that day', async () => {
    const manager = managerOf([{ id: 34 }], [{ route_batch_id: 99 }]);
    expect(await codeOf(service.assertDriverAvailable(manager, 34, '2026-10-20', 12))).toBe('ROUTE_BATCH_DRIVER_NOT_AVAILABLE');
    expect(manager.query.mock.calls[1][1]).toEqual([12, '2026-10-20', 'cancelled', 'closed', 34]);
  });

  it('rejects a vehicle held by another batch, and a driver held by another batch', async () => {
    expect(await codeOf(service.assertResourcesAvailable(managerOf([{ route_batch_id: 99, driver_id: null, vehicle_id: 8 }]), 34, 8, '2026-10-20', 12)))
      .toBe('ROUTE_BATCH_RESOURCE_CONFLICT');
    expect(await codeOf(service.assertResourcesAvailable(managerOf([{ route_batch_id: 99, driver_id: 34, vehicle_id: 7 }]), 34, 8, '2026-10-20', 12)))
      .toBe('ROUTE_BATCH_DRIVER_NOT_AVAILABLE');
  });

  it('does not take a batch without driver for a driver conflict', async () => {
    await expect(service.assertResourcesAvailable(managerOf([{ route_batch_id: 99, driver_id: null, vehicle_id: 7 }]), null, 8, '2026-10-20', 12))
      .resolves.toBeUndefined();
  });
});
