import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { RoleEnum } from '../../../shared/enums/role.enum.js';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator.js';
import { PlanningSnapshotsController } from './planning-snapshots.controller.js';

const service = {
    listCutoffs: vi.fn().mockResolvedValue({ date: '2026-10-14', data: [] }),
    getCoverage: vi.fn().mockResolvedValue({ date: '2026-10-14', available: false }),
    getRouteCompletion: vi.fn().mockResolvedValue({ date: '2026-10-14' }),
};
const controller = new PlanningSnapshotsController(service as never);

describe('PlanningSnapshotsController', () => {
    it('passes the params of each endpoint to the service untouched', async () => {
        await controller.listCutoffs({ date: '2026-10-14' });
        await controller.getCoverage({ date: '2026-10-14', cutoffId: 3, shift: 'morning' });
        await controller.getRouteCompletion({ date: '2026-10-14', zoneId: 1 });

        expect(service.listCutoffs).toHaveBeenCalledWith({ date: '2026-10-14' });
        expect(service.getCoverage).toHaveBeenCalledWith({ date: '2026-10-14', cutoffId: 3, shift: 'morning' });
        expect(service.getRouteCompletion).toHaveBeenCalledWith({ date: '2026-10-14', zoneId: 1 });
    });

    it.each(['listCutoffs', 'getCoverage', 'getRouteCompletion'] as const)('%s is for the coordinator only (root passes every guard)', (method) => {
        const roles = Reflect.getMetadata(ROLES_KEY, PlanningSnapshotsController.prototype[method]) as string[];
        expect(roles).toEqual([RoleEnum.COORDINATOR]);
    });
});
