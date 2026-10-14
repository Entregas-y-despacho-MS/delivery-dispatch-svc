import { describe, expect, it, vi } from 'vitest';
import type { DataSource, EntityManager } from 'typeorm';
import type { RouteCapacityReport } from '../domain/route-capacity.js';
import { RouteCapacityExceededException } from '../exceptions/route-capacity-exceeded.exception.js';
import type { RouteCapacityService } from './route-capacity.service.js';
import { RouteBatchVehicleService } from './route-batch-vehicle.service.js';

const capacityReport: RouteCapacityReport = {
  estimatedDispatchIds: [],
  weight: {
    actual: 0,
    capacity: 100,
    usedPercent: 0,
    remaining: 100,
    excess: 0,
  },
  volume: { actual: 0, capacity: 1, usedPercent: 0, remaining: 1, excess: 0 },
  dimensionViolations: [],
  assignable: true,
};

function setup(options: { status?: string; assignable?: boolean } = {}) {
  const manager = {
    query: vi
      .fn()
      .mockResolvedValue([{ id: 12, status: options.status ?? 'provisional' }]),
  };
  const dataSource = {
    transaction: vi.fn(
      async (work: (manager: EntityManager) => Promise<unknown>) =>
        await work(manager as unknown as EntityManager),
    ),
  };
  const capacity = {
    assertAssignable: vi.fn().mockImplementation(async () => {
      if (options.assignable === false)
        throw new RouteCapacityExceededException({
          ...capacityReport,
          assignable: false,
        });
      return capacityReport;
    }),
  };
  return {
    manager,
    dataSource,
    capacity,
    service: new RouteBatchVehicleService(
      dataSource as unknown as DataSource,
      capacity as unknown as RouteCapacityService,
    ),
  };
}

describe('RouteBatchVehicleService', () => {
  it('checks the load before writing the vehicle assignment in the same transaction', async () => {
    const { manager, capacity, service } = setup();

    await expect(service.assign(12, 8)).resolves.toEqual({
      routeBatchId: 12,
      vehicleId: 8,
      capacity: capacityReport,
    });

    expect(capacity.assertAssignable).toHaveBeenCalledWith(12, 8, manager);
    expect(manager.query).toHaveBeenNthCalledWith(
      2,
      'UPDATE route_batches SET vehicle_id = $2, updated_at = NOW() WHERE route_batch_id = $1',
      [12, 8],
    );
  });

  it('does not assign a vehicle when the capacity check rejects the route', async () => {
    const { manager, service } = setup({ assignable: false });

    await expect(service.assign(12, 8)).rejects.toBeInstanceOf(
      RouteCapacityExceededException,
    );
    expect(manager.query).toHaveBeenCalledTimes(1);
  });

  it('does not assign vehicles to a batch outside provisional status', async () => {
    const { manager, capacity, service } = setup({ status: 'confirmed' });

    await expect(service.assign(12, 8)).rejects.toMatchObject({
      response: { error: 'ROUTE_BATCH_NOT_PROVISIONAL' },
    });
    expect(capacity.assertAssignable).not.toHaveBeenCalled();
    expect(manager.query).toHaveBeenCalledTimes(1);
  });
});
