import { describe, expect, it } from 'vitest';
import { VehicleStatusEnum } from '../../../shared/enums/index.js';
import { FutureCutoffException } from '../exceptions/index.js';
import { summarizeAvailability, type FleetVehicleStatusRow } from './fleet-availability.js';
import { resolveCutoff } from './fleet-cutoff.js';

const row = (vehicleId: number, status: VehicleStatusEnum): FleetVehicleStatusRow => ({ vehicleId, plate: `P-${vehicleId}`, status, capacityKg: 1000, capacityM3: 10 });

describe('resolveCutoff', () => {
    it('defaults to today and is current', () => {
        expect(resolveCutoff(undefined, '2026-11-19')).toEqual({ date: '2026-11-19', kind: 'current' });
    });

    it('is current when it is today and past when it is earlier', () => {
        expect(resolveCutoff('2026-11-19', '2026-11-19').kind).toBe('current');
        expect(resolveCutoff('2026-11-18', '2026-11-19').kind).toBe('past');
    });

    it('rejects a day after today', () => {
        expect(() => resolveCutoff('2026-11-20', '2026-11-19')).toThrow(FutureCutoffException);
    });
});

describe('summarizeAvailability', () => {
    it('counts each vehicle in exactly one group by its current status', () => {
        const rows = [row(1, VehicleStatusEnum.ACTIVE), row(2, VehicleStatusEnum.ACTIVE), row(3, VehicleStatusEnum.MAINTENANCE), row(4, VehicleStatusEnum.OUT_OF_SERVICE)];
        expect(summarizeAvailability(rows, 'current')).toEqual({ assignable: 2, registered: 4, inMaintenance: 1, outOfService: 1, unavailableReason: null });
    });

    it('answers zeros, not N/D, when no vehicle is registered today', () => {
        expect(summarizeAvailability([], 'current')).toEqual({ assignable: 0, registered: 0, inMaintenance: 0, outOfService: 0, unavailableReason: null });
    });

    it('answers N/D for a past cut-off, whatever the rows are', () => {
        const summary = summarizeAvailability([row(1, VehicleStatusEnum.ACTIVE)], 'past');
        expect(summary).toEqual({ assignable: null, registered: null, inMaintenance: null, outOfService: null, unavailableReason: 'no_status_history' });
    });
});
