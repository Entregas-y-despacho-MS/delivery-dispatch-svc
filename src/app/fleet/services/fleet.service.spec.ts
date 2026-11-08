import { describe, expect, it, vi } from 'vitest';
import { FleetService } from './fleet.service.js';

describe('FleetService.findLivePositions (ST-60.1)', () => {
    it('maps a route batch with an in_transit stop and its own last position', async () => {
        const dataSource = { query: vi.fn(async () => [{
            route_batch_id: 93, driver_id: 10, driver_full_name: 'Juan Pérez',
            vehicle_id: 5, vehicle_plate: 'ABC-123',
            zone_id: 2, zone_name: 'Centro',
            current_dispatch_id: 120, current_tracking_code: 'DSP-2026-00120', current_status: 'in_transit',
            last_latitude: '-17.783000', last_longitude: '-63.182000', last_location_at: new Date('2026-11-08T12:00:00.000Z'),
        }]) };
        const service = new FleetService(dataSource as never);

        const result = await service.findLivePositions();

        expect(result).toEqual([{
            routeBatchId: 93, driverId: 10, driverFullName: 'Juan Pérez',
            vehicleId: 5, vehiclePlate: 'ABC-123',
            deliveryZone: { id: 2, name: 'Centro' },
            currentStop: { dispatchId: 120, trackingCode: 'DSP-2026-00120', status: 'in_transit' },
            lastLatitude: -17.783, lastLongitude: -63.182, lastLocationAt: '2026-11-08T12:00:00.000Z',
        }]);
        expect(dataSource.query.mock.calls[0]?.[0]).toContain(`rb.status = 'in_execution'`);
    });

    it('returns null zone, null current stop and null position when none apply', async () => {
        const dataSource = { query: vi.fn(async () => [{
            route_batch_id: 94, driver_id: 11, driver_full_name: 'Ana Gómez',
            vehicle_id: 6, vehicle_plate: 'XYZ-789',
            zone_id: null, zone_name: null,
            current_dispatch_id: null, current_tracking_code: null, current_status: null,
            last_latitude: null, last_longitude: null, last_location_at: null,
        }]) };
        const service = new FleetService(dataSource as never);

        const result = await service.findLivePositions();

        expect(result).toEqual([{
            routeBatchId: 94, driverId: 11, driverFullName: 'Ana Gómez',
            vehicleId: 6, vehiclePlate: 'XYZ-789',
            deliveryZone: null, currentStop: null,
            lastLatitude: null, lastLongitude: null, lastLocationAt: null,
        }]);
    });

    it('restricts the current-stop candidates to the statuses that keep a route open (not incident/not_delivered)', async () => {
        const dataSource = { query: vi.fn(async () => []) };
        const service = new FleetService(dataSource as never);

        await service.findLivePositions();

        expect(dataSource.query.mock.calls[0]?.[1]).toEqual([['assigned', 'out_for_delivery', 'in_transit']]);
    });

    it('returns an empty array when no route batch is in execution', async () => {
        const dataSource = { query: vi.fn(async () => []) };
        const service = new FleetService(dataSource as never);

        await expect(service.findLivePositions()).resolves.toEqual([]);
    });
});
