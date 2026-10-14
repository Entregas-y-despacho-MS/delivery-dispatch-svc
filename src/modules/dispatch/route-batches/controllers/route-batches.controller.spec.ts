// ST-50.4 — el actor de la reasignación manual sale siempre del token.
import { describe, expect, it, vi } from 'vitest';
import type { RouteBatchReviewerService } from '../services/route-batch-reviewer.service.js';
import type { RouteBatchVehicleService } from '../services/route-batch-vehicle.service.js';
import { RouteBatchesController } from './route-batches.controller.js';

describe('RouteBatchesController.reassignReviewer', () => {
  it('delega en el servicio con el lote, el nuevo revisor, el usuario del token y el motivo', async () => {
    const reviewer = {
      reassignReviewer: vi.fn().mockResolvedValue({
        id: 5,
        status: 'provisional',
        reviewerUserId: 12,
        version: 0,
      }),
    };
    const controller = new RouteBatchesController(
      reviewer as unknown as RouteBatchReviewerService,
      {} as unknown as RouteBatchVehicleService,
    );

    const result = await controller.reassignReviewer(
      5,
      { reviewerUserId: 12, reason: 'Leave' },
      9,
    );

    expect(reviewer.reassignReviewer).toHaveBeenCalledWith(5, 12, 9, 'Leave');
    expect(result).toEqual({
      id: 5,
      status: 'provisional',
      reviewerUserId: 12,
      version: 0,
    });
  });

  it('delega la asignación del vehículo con el identificador del lote', async () => {
    const reviewer = {};
    const vehicles = {
      assign: vi.fn().mockResolvedValue({
        routeBatchId: 5,
        vehicleId: 8,
        capacity: { assignable: true },
      }),
    };
    const controller = new RouteBatchesController(
      reviewer as unknown as RouteBatchReviewerService,
      vehicles as unknown as RouteBatchVehicleService,
    );

    await expect(
      controller.assignVehicle(5, { vehicleId: 8 }),
    ).resolves.toMatchObject({ routeBatchId: 5, vehicleId: 8 });
    expect(vehicles.assign).toHaveBeenCalledWith(5, 8);
  });
});
