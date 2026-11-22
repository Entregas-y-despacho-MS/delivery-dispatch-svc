import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { RoleEnum } from '../../../shared/enums/role.enum.js';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator.js';
import { DeliveryPromiseController } from './delivery-promise.controller.js';

function controller() {
    const otd = { getOtd: vi.fn().mockResolvedValue({ basis: 'promise' }) };
    const backlog = { getBacklog: vi.fn().mockResolvedValue({ empty: true }) };
    return { controller: new DeliveryPromiseController(otd as never, backlog as never), otd, backlog };
}

describe('DeliveryPromiseController', () => {
    it('passes the filters and the basis of the request to the OTD service', async () => {
        const { controller: ctrl, otd } = controller();
        const params = { from: '2026-11-01', to: '2026-11-30', zoneId: 3, basis: 'deliveredAt' } as never;
        await ctrl.getOtd(params);
        expect(otd.getOtd).toHaveBeenCalledWith(params, 'deliveredAt');
    });

    it('leaves the basis undefined when the request has none, so the service uses the cohort of promise', async () => {
        const { controller: ctrl, otd } = controller();
        await ctrl.getOtd({ from: '2026-11-01', to: '2026-11-30' } as never);
        expect(otd.getOtd.mock.calls[0][1]).toBeUndefined();
    });

    it('passes the filters and the size of the list to the backlog service', async () => {
        const { controller: ctrl, backlog } = controller();
        const params = { from: '2026-11-01', to: '2026-11-30', overdueLimit: 20 } as never;
        await ctrl.getBacklog(params);
        expect(backlog.getBacklog).toHaveBeenCalledWith(params, 20);
    });

    it('is for the coordinator only (root passes every guard)', () => {
        for (const method of ['getOtd', 'getBacklog'] as const) {
            const roles = Reflect.getMetadata(ROLES_KEY, DeliveryPromiseController.prototype[method]) as string[];
            expect(roles, method).toEqual([RoleEnum.COORDINATOR]);
        }
    });
});
