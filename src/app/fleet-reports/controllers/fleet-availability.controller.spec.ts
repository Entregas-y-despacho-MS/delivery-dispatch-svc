import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { RoleEnum } from '../../../shared/enums/index.js';
import { ROLES_KEY } from '../../auth/decorators/index.js';
import { FleetAvailabilityController } from './fleet-availability.controller.js';

describe('FleetAvailabilityController', () => {
    it('serves GET /fleet/availability and permits coordinators and supervisors', () => {
        expect(Reflect.getMetadata('path', FleetAvailabilityController)).toBe('fleet/availability');
        expect(Reflect.getMetadata('path', FleetAvailabilityController.prototype.get)).toBe('/');
        expect(Reflect.getMetadata(ROLES_KEY, FleetAvailabilityController.prototype.get)).toEqual([RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR]);
    });

    it('passes the query and the role of the token to the service', async () => {
        const answer = { n: 0 };
        const get = vi.fn().mockResolvedValue(answer);
        const controller = new FleetAvailabilityController({ get } as never);
        const params = { cutoff: '2026-11-19', vehicleId: 3 };

        await expect(controller.get(params, RoleEnum.COORDINATOR)).resolves.toBe(answer);
        expect(get).toHaveBeenCalledWith(params, RoleEnum.COORDINATOR);
    });
});
