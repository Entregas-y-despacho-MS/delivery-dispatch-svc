import { describe, expect, it, vi } from 'vitest';
import { DriverMetricsPeriod } from '../../driver-metrics/domain/metrics-period.js';
import { SlaGroupBy } from '../../sla-report/domain/sla-group-by.js';
import { buildSlaReport } from '../../sla-report/domain/sla-metrics.js';
import { FleetKpisService } from './fleet-kpis.service.js';

// Wednesday 2026-10-21 11:00 in Bolivia (UTC-4).
const NOW = new Date('2026-10-21T15:00:00Z');

const sums = (groupId: number | null, groupName: string | null, delivered: number, onTime: number, incidents: number) => ({
    groupId, groupName, closedCount: delivered, deliveredCount: delivered, onTimeCount: onTime, lateCount: delivered - onTime,
    delayMinutesSum: 0, cycleCount: 0, cycleMinutesSum: 0, incidentCount: incidents,
});

function build() {
    const aggregate = vi.fn((from: string, to: string, groupBy: SlaGroupBy) =>
        Promise.resolve(buildSlaReport(from, to, groupBy, groupBy === SlaGroupBy.DRIVER
            ? [sums(1, 'Ana', 4, 3, 1), sums(2, 'Beto', 2, 2, 0)]
            : [sums(7, '1234ABC', 6, 5, 1)])));
    return { aggregate, service: new FleetKpisService({ aggregate } as never) };
}

describe('FleetKpisService', () => {
    it.each([
        [DriverMetricsPeriod.TODAY, '2026-10-21', '2026-10-21'],
        [DriverMetricsPeriod.WEEK, '2026-10-19', '2026-10-21'],
        [DriverMetricsPeriod.MONTH, '2026-10-01', '2026-10-21'],
    ])('resolves %s to Bolivia days and asks the SLA aggregation for the drivers and for the vehicles', async (period, from, to) => {
        const { aggregate, service } = build();

        const kpis = await service.get(period, NOW);

        expect(aggregate).toHaveBeenCalledTimes(2);
        expect(aggregate).toHaveBeenCalledWith(from, to, SlaGroupBy.DRIVER);
        expect(aggregate).toHaveBeenCalledWith(from, to, SlaGroupBy.VEHICLE);
        expect(kpis).toMatchObject({ period, from, to });
    });

    it('answers the totals and the drivers of the driver aggregation and the plates of the vehicle one', async () => {
        const { service } = build();

        const kpis = await service.get(DriverMetricsPeriod.WEEK, NOW);

        expect(kpis.totals).toMatchObject({ closedCount: 6, deliveredCount: 6, onTimeCount: 5, onTimePercentage: 83.3, incidentCount: 1 });
        expect(kpis.drivers.map((r) => r.groupName)).toEqual(['Ana', 'Beto']);
        expect(kpis.vehicles).toMatchObject([{ groupId: 7, groupName: '1234ABC', deliveredCount: 6 }]);
    });

    it('answers empty lists and zeros for a period without closed dispatches', async () => {
        const aggregate = vi.fn((from: string, to: string, groupBy: SlaGroupBy) => Promise.resolve(buildSlaReport(from, to, groupBy, [])));
        const kpis = await new FleetKpisService({ aggregate } as never).get(DriverMetricsPeriod.TODAY, NOW);

        expect(kpis.drivers).toEqual([]);
        expect(kpis.vehicles).toEqual([]);
        expect(kpis.totals).toMatchObject({ closedCount: 0, onTimePercentage: 0, incidentCount: 0 });
    });

    it('does not swallow a failure of the aggregation', async () => {
        const service = new FleetKpisService({ aggregate: vi.fn().mockRejectedValue(new Error('boom')) } as never);
        await expect(service.get(DriverMetricsPeriod.TODAY, NOW)).rejects.toThrow('boom');
    });
});
