import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { RoleEnum } from '../../../shared/enums/index.js';
import { ROLES_KEY } from '../../auth/decorators/index.js';
import { SlaGroupBy } from '../domain/sla-group-by.js';
import { SlaReportController } from './sla-report.controller.js';

describe('SlaReportController', () => {
    it('serves GET /reports/sla', () => {
        expect(Reflect.getMetadata('path', SlaReportController)).toBe('reports/sla');
        expect(Reflect.getMetadata('path', SlaReportController.prototype.getReport)).toBe('/');
    });

    it('is for the coordinator only (the guard lets root through): the supervisor and the driver get 403', () => {
        expect(Reflect.getMetadata(ROLES_KEY, SlaReportController.prototype.getReport)).toEqual([RoleEnum.COORDINATOR]);
    });

    it('asks the service for the range and grouping of the query and answers what it returns', async () => {
        const report = { from: '2026-10-01', to: '2026-10-31', groupBy: SlaGroupBy.DRIVER, totals: {}, rows: [] };
        const aggregate = vi.fn().mockResolvedValue(report);
        const controller = new SlaReportController({ aggregate } as never);

        const answer = await controller.getReport({ from: '2026-10-01', to: '2026-10-31', groupBy: SlaGroupBy.DRIVER });

        expect(aggregate).toHaveBeenCalledWith('2026-10-01', '2026-10-31', SlaGroupBy.DRIVER);
        expect(answer).toBe(report);
    });
});
