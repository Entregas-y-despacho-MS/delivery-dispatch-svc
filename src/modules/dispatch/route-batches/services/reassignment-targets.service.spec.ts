import { describe, expect, it, vi } from 'vitest';
import { ReassignmentTargetsService } from './reassignment-targets.service.js';
import { RouteBatchNotFoundException } from '../exceptions/route-batch-not-found.exception.js';

function build() {
    const dataSource = { query: vi.fn() };
    const capacity = { report: vi.fn() };
    const service = new ReassignmentTargetsService(dataSource as never, capacity as never);
    return { service, dataSource, capacity };
}

describe('ReassignmentTargetsService.findTargets', () => {
    it('lists the other in_execution batches of the same shift day, with remaining capacity', async () => {
        const { service, dataSource, capacity } = build();
        dataSource.query
            .mockResolvedValueOnce([{ shift_date: '2026-11-09' }])
            .mockResolvedValueOnce([
                { route_batch_id: 20, version: 3, driver_id: 9, driver_full_name: 'Ana', vehicle_id: 7, vehicle_plate: 'XYZ-789', zone_id: 2, zone_name: 'Norte' },
            ]);
        capacity.report.mockResolvedValue({ weight: { remaining: 179.5 }, volume: { remaining: 0.4 } });

        const result = await service.findTargets(10);

        expect(result).toEqual([{
            routeBatchId: 20, version: 3, driverId: 9, driverFullName: 'Ana',
            vehicleId: 7, vehiclePlate: 'XYZ-789', zoneId: 2, zoneName: 'Norte',
            remainingWeightKg: 179.5, remainingVolumeM3: 0.4,
        }]);
        expect(capacity.report).toHaveBeenCalledWith(20, 7, undefined, { lock: false });
        expect(dataSource.query.mock.calls[1][0]).toContain(`rb.route_batch_id != $3`);
        expect(dataSource.query.mock.calls[1][1]).toEqual(['in_execution', '2026-11-09', 10]);
    });

    it('404s when the origin batch does not exist', async () => {
        const { service, dataSource } = build();
        dataSource.query.mockResolvedValueOnce([]);

        await expect(service.findTargets(999)).rejects.toThrow(RouteBatchNotFoundException);
    });

    it('returns an empty list when there is no other in_execution batch that day', async () => {
        const { service, dataSource, capacity } = build();
        dataSource.query.mockResolvedValueOnce([{ shift_date: '2026-11-09' }]).mockResolvedValueOnce([]);

        const result = await service.findTargets(10);

        expect(result).toEqual([]);
        expect(capacity.report).not.toHaveBeenCalled();
    });
});
