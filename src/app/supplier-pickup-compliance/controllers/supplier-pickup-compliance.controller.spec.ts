import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { RoleEnum } from '../../../shared/enums/role.enum.js';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator.js';
import { SupplierPickupComplianceController } from './supplier-pickup-compliance.controller.js';

function controller() {
    const service = { getCompliance: vi.fn().mockResolvedValue({ empty: true }) };
    return { controller: new SupplierPickupComplianceController(service as never), service };
}

describe('SupplierPickupComplianceController', () => {
    it('passes the filters and, apart, the size of the exceptions list to the service', async () => {
        const { controller: ctrl, service } = controller();
        await ctrl.getCompliance({ from: '2026-11-01', to: '2026-11-30', supplierId: 'SUP-1', warehouseId: 2, exceptionLimit: 20 } as never);
        expect(service.getCompliance).toHaveBeenCalledWith({ from: '2026-11-01', to: '2026-11-30', supplierId: 'SUP-1', warehouseId: 2 }, 20);
    });

    it('leaves the limit undefined when the request has none, so the service uses its default', async () => {
        const { controller: ctrl, service } = controller();
        await ctrl.getCompliance({ from: '2026-11-01', to: '2026-11-30' } as never);
        expect(service.getCompliance.mock.calls[0][1]).toBeUndefined();
    });

    it('is for the coordinator only (root passes every guard)', () => {
        const roles = Reflect.getMetadata(ROLES_KEY, SupplierPickupComplianceController.prototype.getCompliance) as string[];
        expect(roles).toEqual([RoleEnum.COORDINATOR]);
    });
});
