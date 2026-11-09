import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { RoleEnum } from '../../../shared/enums/index.js';
import { ROLES_KEY } from '../../auth/decorators/index.js';
import { FleetReportsController } from './fleet-reports.controller.js';

describe('FleetReportsController', () => {
    it('serves GET /fleet/reports and permits coordinators and supervisors', () => {
        expect(Reflect.getMetadata('path', FleetReportsController)).toBe('fleet/reports');
        expect(Reflect.getMetadata('path', FleetReportsController.prototype.getReport)).toBe('/');
        expect(Reflect.getMetadata(ROLES_KEY, FleetReportsController.prototype.getReport)).toEqual([RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR]);
    });

    it('delegates the requested inclusive range to the report service', async () => {
        const report = { from: '2026-10-01', to: '2026-10-31', drivers: [], vehicles: [] };
        const get = vi.fn().mockResolvedValue(report);
        const controller = new FleetReportsController({ get } as never);

        await expect(controller.getReport({ from: report.from, to: report.to })).resolves.toBe(report);
        expect(get).toHaveBeenCalledWith(report.from, report.to);
    });
});
