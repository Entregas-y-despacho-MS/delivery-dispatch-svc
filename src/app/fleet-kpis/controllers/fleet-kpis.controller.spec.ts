import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { RoleEnum } from '../../../shared/enums/index.js';
import { ROLES_KEY } from '../../auth/decorators/index.js';
import { DriverMetricsPeriod } from '../../driver-metrics/domain/metrics-period.js';
import { FleetKpisController } from './fleet-kpis.controller.js';

describe('FleetKpisController', () => {
    it('serves GET /fleet/kpis', () => {
        expect(Reflect.getMetadata('path', FleetKpisController)).toBe('fleet/kpis');
        expect(Reflect.getMetadata('path', FleetKpisController.prototype.getKpis)).toBe('/');
    });

    it('is for the coordinator and the supervisor (the guard lets root through): the driver gets 403', () => {
        expect(Reflect.getMetadata(ROLES_KEY, FleetKpisController.prototype.getKpis)).toEqual([RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR]);
    });

    it('asks the service for the period of the query and answers what it returns', async () => {
        const kpis = { period: DriverMetricsPeriod.MONTH, drivers: [], vehicles: [] };
        const get = vi.fn().mockResolvedValue(kpis);

        const answer = await new FleetKpisController({ get } as never).getKpis({ period: DriverMetricsPeriod.MONTH });

        expect(get).toHaveBeenCalledWith(DriverMetricsPeriod.MONTH);
        expect(answer).toBe(kpis);
    });
});
