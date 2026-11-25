import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { RoleEnum } from '../../../shared/enums/role.enum.js';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator.js';
import { QualityKpisController } from './quality-kpis.controller.js';

function controller() {
    const service = { getQualityKpis: vi.fn().mockResolvedValue({ kpis: {} }) };
    return { controller: new QualityKpisController(service as never), service };
}
const user = (role: RoleEnum) => ({ id: 1, username: 'u', roleId: 1, role, mustChangePassword: false }) as never;
const PARAMS = { from: '2026-11-01', to: '2026-11-30', timeZone: 'America/La_Paz', zoneId: 3, reasonCode: 'DAMAGED', page: 2, limit: 5, order: 'asc' } as never;

describe('QualityKpisController', () => {
    it('splits the filters from the page and passes them to the service, without the time zone', async () => {
        const { controller: ctrl, service } = controller();
        await ctrl.getQuality(PARAMS, user(RoleEnum.SUPERVISOR));
        expect(service.getQualityKpis).toHaveBeenCalledWith(
            { from: '2026-11-01', to: '2026-11-30', zoneId: 3, reasonCode: 'DAMAGED' },
            { ratingsAuthorized: true, page: 2, limit: 5, order: 'asc' },
        );
    });

    it('authorizes the global rating for the supervisor and root, never for the coordinator', async () => {
        const { controller: ctrl, service } = controller();
        const authorized: Record<string, boolean> = {};
        for (const role of [RoleEnum.ROOT, RoleEnum.SUPERVISOR, RoleEnum.COORDINATOR]) {
            await ctrl.getQuality(PARAMS, user(role));
            authorized[role] = service.getQualityKpis.mock.lastCall![1].ratingsAuthorized;
        }
        expect(authorized).toEqual({ root: true, supervisor: true, coordinator: false });
    });

    it('rejects a reversed or too long range before touching the data', async () => {
        const { controller: ctrl, service } = controller();
        await expect(ctrl.getQuality({ from: '2026-11-30', to: '2026-11-01' } as never, user(RoleEnum.COORDINATOR))).rejects.toMatchObject({ response: { error: 'INVALID_DATE_RANGE' } });
        await expect(ctrl.getQuality({ from: '2025-01-01', to: '2026-11-30' } as never, user(RoleEnum.COORDINATOR))).rejects.toMatchObject({ response: { error: 'DATE_RANGE_TOO_LARGE' } });
        expect(service.getQualityKpis).not.toHaveBeenCalled();
    });

    it('is for the coordinator and the supervisor only (root passes every guard)', () => {
        const roles = Reflect.getMetadata(ROLES_KEY, QualityKpisController.prototype.getQuality) as string[];
        expect(roles).toEqual([RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR]);
    });
});
