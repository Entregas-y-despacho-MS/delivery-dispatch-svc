import { describe, expect, it, vi } from 'vitest';
import { VehicleStatusEnum } from '../../../shared/enums/index.js';
import { FutureCutoffException } from '../exceptions/index.js';
import { FleetAvailabilityService } from './fleet-availability.service.js';

// 2026-11-19 15:00 in Bolivia (UTC-4).
const NOW = new Date('2026-11-19T19:00:00Z');
const rows = [
    { vehicleId: 1, plate: 'A-1', status: VehicleStatusEnum.ACTIVE },
    { vehicleId: 2, plate: 'B-2', status: VehicleStatusEnum.MAINTENANCE },
    { vehicleId: 3, plate: 'C-3', status: VehicleStatusEnum.OUT_OF_SERVICE },
];

function build(result = rows) {
    const repository = { listRegistered: vi.fn().mockResolvedValue(result) };
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

    it('uses the Bolivia day, not the UTC one, for today', async () => {
        const { service } = build();
        // 02:00 UTC of the 20th is still the 19th in Bolivia: a cut-off of the 19th is current, the 20th is the future.
        const lateNight = new Date('2026-11-20T02:00:00Z');
        expect((await service.atCutoff({ cutoff: '2026-11-19' }, lateNight)).cutoff.kind).toBe('current');
        await expect(service.atCutoff({ cutoff: '2026-11-20' }, lateNight)).rejects.toThrow(FutureCutoffException);
    });
});
