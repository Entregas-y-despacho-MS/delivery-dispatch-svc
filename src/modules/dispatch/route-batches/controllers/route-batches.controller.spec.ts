// ST-50.4 — el actor de la reasignación manual sale siempre del token.
import { describe, expect, it, vi } from 'vitest';
import type { RouteBatchReviewerService } from '../services/route-batch-reviewer.service.js';
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
      {} as any,
      {} as any,
      {} as any,
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

  it('delegates promise approval with the actor from the access token', async () => {
    const approval = { approve: vi.fn().mockResolvedValue({ routeBatchId: 5, version: 1 }) };
    const controller = new RouteBatchesController({} as any, approval as any, {} as any, {} as any);
    const body = { version: 0, dispatches: [{ dispatchId: 12, version: 0 }] };

    await expect(controller.approvePromises(5, body, 9)).resolves.toMatchObject({ routeBatchId: 5 });
    expect(approval.approve).toHaveBeenCalledWith(5, body, 9);
  });

  it('delega la lista y el detalle en el servicio de consulta', async () => {
    const query = {
      findAll: vi.fn().mockResolvedValue({ data: [], meta: { page: 1, limit: 10, total: 0, pages: 0 } }),
      findOne: vi.fn().mockResolvedValue({ id: 5 }),
    };
    const controller = new RouteBatchesController({} as any, {} as any, {} as any, query as any);
    const params = { page: 1, limit: 10, status: 'provisional' } as any;

    await expect(controller.findAll(params)).resolves.toMatchObject({ data: [] });
    await expect(controller.findOne(5)).resolves.toEqual({ id: 5 });
    expect(query.findAll).toHaveBeenCalledWith(params);
    expect(query.findOne).toHaveBeenCalledWith(5);
  });

  it('delegates reassignment to its service with the batch id, the body and the actor from the token', async () => {
    const reassignment = { reassign: vi.fn().mockResolvedValue({ fromBatchId: 10, toBatchId: 20, movedDispatchIds: [31], fromVersion: 6, toVersion: 3, fromBatchClosed: false }) };
    const controller = new RouteBatchesController(
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      reassignment as any, {} as any,
    );
    const dto = { dispatchIds: [31], targetBatchId: 20, reasonCode: 'DRIVER-BREAKDOWN', version: 5, targetVersion: 2 };

    const result = await controller.reassign(10, dto, 9);

    expect(reassignment.reassign).toHaveBeenCalledWith(10, dto, 9);
    expect(result).toEqual({ fromBatchId: 10, toBatchId: 20, movedDispatchIds: [31], fromVersion: 6, toVersion: 3, fromBatchClosed: false });
  });

  it('delegates reassignment targets to its service with the batch id', async () => {
    const targets = { findTargets: vi.fn().mockResolvedValue([{ routeBatchId: 20 }]) };
    const controller = new RouteBatchesController(
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, targets as any,
    );

    const result = await controller.findReassignmentTargets(10);

    expect(targets.findTargets).toHaveBeenCalledWith(10);
    expect(result).toEqual([{ routeBatchId: 20 }]);
  });
});
