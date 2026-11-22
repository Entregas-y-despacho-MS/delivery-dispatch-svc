import { describe, expect, it, vi } from 'vitest';
import { VehicleStatusEnum } from '../../../shared/enums/index.js';
import { FutureCutoffException } from '../exceptions/index.js';
import type { RouteLoad } from '../domain/fleet-load.js';
import { FleetAvailabilityService } from './fleet-availability.service.js';

// 2026-11-19 15:00 in Bolivia (UTC-4).
const NOW = new Date('2026-11-19T19:00:00Z');
const rows = [
    { vehicleId: 1, plate: 'A-1', capacityKg: 1000, capacityM3: 10, status: VehicleStatusEnum.ACTIVE },
    { vehicleId: 2, plate: 'B-2', capacityKg: 1000, capacityM3: 10, status: VehicleStatusEnum.MAINTENANCE },
    { vehicleId: 3, plate: 'C-3', capacityKg: 1000, capacityM3: 10, status: VehicleStatusEnum.OUT_OF_SERVICE },
];

function build(result = rows, intervals: Array<{ vehicleId: number; startDay: string; endDay: string | null }> = [], loads: RouteLoad[] = []) {
    const repository = { listRegistered: vi.fn().mockResolvedValue(result), listMaintenanceIntervals: vi.fn().mockResolvedValue(intervals), listRouteLoads: vi.fn().mockResolvedValue(loads) };
    return { repository, service: new FleetAvailabilityService(repository as never) };
}

describe('FleetAvailabilityService.atCutoff', () => {
    it('summarizes the registered vehicles of today and lists them all', async () => {
        const { service, repository } = build();
        const answer = await service.atCutoff({}, NOW);
        expect(repository.listRegistered).toHaveBeenCalledWith(undefined);
        expect(answer.cutoff).toEqual({ date: '2026-11-19', kind: 'current' });
        expect(answer.summary).toMatchObject({ assignable: 1, registered: 3, inMaintenance: 1, outOfService: 1 });
        expect(answer.vehicles).toHaveLength(3);
    });

    it('narrows the list by fleetStatus without changing the summary denominator', async () => {
        const { service } = build();
        const answer = await service.atCutoff({ fleetStatus: VehicleStatusEnum.MAINTENANCE }, NOW);
        expect(answer.vehicles.map((v) => v.vehicleId)).toEqual([2]);
        expect(answer.summary.registered).toBe(3);
    });

    it('passes the vehicleId filter to the query', async () => {
        const { service, repository } = build([rows[0]]);
        await service.atCutoff({ vehicleId: 1 }, NOW);
        expect(repository.listRegistered).toHaveBeenCalledWith(1);
    });

    it('answers N/D without querying for a past cut-off', async () => {
        const { service, repository } = build();
        const answer = await service.atCutoff({ cutoff: '2026-11-10' }, NOW);
        expect(repository.listRegistered).not.toHaveBeenCalled();
        expect(answer.cutoff.kind).toBe('past');
        expect(answer.summary.assignable).toBeNull();
        expect(answer.vehicles).toEqual([]);
    });

    it('merges the maintenance of the given vehicles and passes the filters to the query', async () => {
        const { service, repository } = build(rows, [
            { vehicleId: 2, startDay: '2026-11-03', endDay: '2026-11-08' },
            { vehicleId: 2, startDay: '2026-11-06', endDay: '2026-11-10' },
        ]);
        const result = await service.maintenance([1, 2], { from: '2026-11-01', to: '2026-11-30' }, { routine: true });
        expect(repository.listMaintenanceIntervals).toHaveBeenCalledWith('2026-11-01', '2026-11-30', { vehicleIds: [1, 2], maintenanceTypeId: undefined, routine: true });
        expect(result.byVehicle.get(2)).toEqual({ count: 2, calendarDays: 8, overlapsDetected: true });
        expect(result.byVehicle.get(1)).toEqual({ count: 0, calendarDays: 0, overlapsDetected: false });
        expect(result.total).toEqual({ count: 2, calendarDays: 8, overlapsDetected: true });
    });

    it('does not query the maintenance when there are no vehicles', async () => {
        const { service, repository } = build();
        const result = await service.maintenance([], { from: '2026-11-01', to: '2026-11-30' }, {});
        expect(repository.listMaintenanceIntervals).not.toHaveBeenCalled();
        expect(result.total).toEqual({ count: 0, calendarDays: 0, overlapsDetected: false });
    });

    it('attributes the load of each vehicle only from its own routes and answers N/D without routes', async () => {
        const { service, repository } = build(rows, [], [{ routeBatchId: 9, vehicleId: 1, dispatches: 2, weightKg: 500, volumeM3: 4, withoutWeight: 0, withoutVolume: 0 }]);
        const load = await service.load(rows, { from: '2026-11-19', to: '2026-11-19' });
        expect(repository.listRouteLoads).toHaveBeenCalledWith('2026-11-19', '2026-11-19', [1, 2, 3]);
        expect(load.get(1)).toMatchObject({ routes: 1, n: 2, kg: { used: 500, capacity: 1000, ratio: 0.5 }, m3: { used: 4, capacity: 10, ratio: 0.4 }, unavailableReason: null });
        expect(load.get(2)).toMatchObject({ kg: null, m3: null, routes: 0, unavailableReason: 'no_route_in_period' });
    });

    it('does not query the routes when there are no vehicles', async () => {
        const { service, repository } = build();
        expect((await service.load([], { from: '2026-11-19', to: '2026-11-19' })).size).toBe(0);
        expect(repository.listRouteLoads).not.toHaveBeenCalled();
    });

    it('uses the Bolivia day, not the UTC one, for today', async () => {
        const { service } = build();
        // 02:00 UTC of the 20th is still the 19th in Bolivia: a cut-off of the 19th is current, the 20th is the future.
        const lateNight = new Date('2026-11-20T02:00:00Z');
        expect((await service.atCutoff({ cutoff: '2026-11-19' }, lateNight)).cutoff.kind).toBe('current');
        await expect(service.atCutoff({ cutoff: '2026-11-20' }, lateNight)).rejects.toThrow(FutureCutoffException);
    });
});
