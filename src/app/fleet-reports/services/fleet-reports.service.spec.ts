import { describe, expect, it, vi } from 'vitest';
import { SlaGroupBy } from '../../sla-report/domain/sla-group-by.js';
import { buildSlaReport } from '../../sla-report/domain/sla-metrics.js';
import { FleetReportsService } from './fleet-reports.service.js';

function setup() {
    const sla = { compute: vi.fn((from: string, to: string, groupBy: SlaGroupBy) => Promise.resolve(buildSlaReport(from, to, groupBy,
        groupBy === SlaGroupBy.DRIVER
            ? [{ groupId: 4, groupName: 'Ana', closedCount: 2, deliveredCount: 2, onTimeCount: 1, lateCount: 1, delayMinutesSum: 3, cycleCount: 2, cycleMinutesSum: 20, incidentCount: 1 }]
            : [{ groupId: 9, groupName: 'ABC123', closedCount: 2, deliveredCount: 2, onTimeCount: 1, lateCount: 1, delayMinutesSum: 3, cycleCount: 2, cycleMinutesSum: 20, incidentCount: 1 }])) ) };
    const maintenance = { aggregate: vi.fn().mockResolvedValue([{ vehicleId: 9, maintenanceCount: 2, daysInMaintenance: 4 }]) };
    const cache = { get: vi.fn().mockResolvedValue(null), setWithTtl: vi.fn().mockResolvedValue(undefined) };
    return { service: new FleetReportsService(sla as never, maintenance as never, cache as never), sla, maintenance, cache };
}

describe('FleetReportsService', () => {
    it('returns driver and vehicle SLA rows enriched with maintenance and stores the whole report for 600 seconds', async () => {
        const { service, sla, maintenance, cache } = setup();

        const report = await service.get('2026-10-01', '2026-10-31');

        expect(sla.compute).toHaveBeenCalledWith('2026-10-01', '2026-10-31', SlaGroupBy.DRIVER);
        expect(sla.compute).toHaveBeenCalledWith('2026-10-01', '2026-10-31', SlaGroupBy.VEHICLE);
        expect(maintenance.aggregate).toHaveBeenCalledWith('2026-10-01', '2026-10-31');
        expect(report.drivers[0]).toMatchObject({ groupName: 'Ana', closedCount: 2, incidentCount: 1 });
        expect(report.vehicles[0]).toMatchObject({ groupName: 'ABC123', maintenanceCount: 2, daysInMaintenance: 4 });
        expect(cache.setWithTtl).toHaveBeenCalledWith('reports:fleet:2026-10-01:2026-10-31', JSON.stringify(report), 600);
    });

    it('returns empty lists when there are no closed dispatches', async () => {
        const empty = buildSlaReport('2026-10-01', '2026-10-31', SlaGroupBy.DRIVER, []);
        const noRows = { compute: vi.fn().mockResolvedValue(empty) };
        const report = await new FleetReportsService(noRows as never, { aggregate: vi.fn().mockResolvedValue([]) } as never, { get: vi.fn().mockResolvedValue(null), setWithTtl: vi.fn() } as never).get('2026-10-01', '2026-10-31');
        expect(report.drivers).toEqual([]);
        expect(report.vehicles).toEqual([]);
    });

    it('includes vehicles with overlapping maintenance even when they have no closed dispatches', async () => {
        const empty = buildSlaReport('2026-10-01', '2026-10-31', SlaGroupBy.DRIVER, []);
        const maintenance = { aggregate: vi.fn().mockResolvedValue([{ vehicleId: 7, vehiclePlate: 'ABC-123', maintenanceCount: 1, daysInMaintenance: 3 }]) };
        const service = new FleetReportsService(
            { compute: vi.fn().mockResolvedValue(empty) } as never,
            maintenance as never,
            { get: vi.fn().mockResolvedValue(null), setWithTtl: vi.fn() } as never,
        );

        await expect(service.get('2026-10-01', '2026-10-31')).resolves.toMatchObject({
            vehicles: [{ groupId: 7, groupName: 'ABC-123', closedCount: 0, maintenanceCount: 1, daysInMaintenance: 3 }],
        });
    });

    it('serves a valid composed cache hit without querying PostgreSQL', async () => {
        const { service, sla, maintenance, cache } = setup();
        const cached = { from: '2026-10-01', to: '2026-10-31', drivers: [], vehicles: [] };
        cache.get.mockResolvedValue(JSON.stringify(cached));

        await expect(service.get(cached.from, cached.to)).resolves.toEqual(cached);
        expect(sla.compute).not.toHaveBeenCalled();
        expect(maintenance.aggregate).not.toHaveBeenCalled();
    });

    it('falls back to PostgreSQL when Redis read/write fails', async () => {
        const { service, cache } = setup();
        cache.get.mockRejectedValue(new Error('redis down'));
        cache.setWithTtl.mockRejectedValue(new Error('redis down'));

        await expect(service.get('2026-10-01', '2026-10-31')).resolves.toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    });

    it('rejects reversed and overlong ranges before cache/database access', async () => {
        const { service, cache } = setup();
        await expect(service.get('2026-10-02', '2026-10-01')).rejects.toMatchObject({ response: { error: 'INVALID_DATE_RANGE' } });
        await expect(service.get('2025-01-01', '2026-01-02')).rejects.toMatchObject({ response: { error: 'DATE_RANGE_TOO_LARGE' } });
        expect(cache.get).not.toHaveBeenCalled();
    });
});
