import { describe, expect, it } from 'vitest';
import { RoleEnum } from '../../../shared/enums/index.js';
import { buildDriverProductivity, canSeeDriverDetail, type DriverProductivityRow } from './fleet-productivity.js';

const rows: DriverProductivityRow[] = [
    { driverId: 5, driverName: 'Ana', closedCount: 10, deliveredCount: 8 },
    { driverId: 6, driverName: 'Luis', closedCount: 4, deliveredCount: 4 },
    { driverId: null, driverName: null, closedCount: 2, deliveredCount: 0 },
];

describe('canSeeDriverDetail', () => {
    it.each([[RoleEnum.SUPERVISOR, true], [RoleEnum.ROOT, true], [RoleEnum.COORDINATOR, false], [RoleEnum.ADMIN, false], [RoleEnum.DRIVER, false]])('%s -> %s', (role, expected) => {
        expect(canSeeDriverDetail(role)).toBe(expected);
    });
});

describe('buildDriverProductivity', () => {
    it('gives the supervisor each driver with its deliveries and attempts, and totals that include the dispatches without driver', () => {
        expect(buildDriverProductivity(rows, RoleEnum.SUPERVISOR)).toEqual({
            detailRestricted: false,
            deliveredCount: 12,
            attemptCount: 16,
            drivers: [
                { driverId: 5, driverName: 'Ana', deliveredCount: 8, attemptCount: 10 },
                { driverId: 6, driverName: 'Luis', deliveredCount: 4, attemptCount: 4 },
            ],
        });
    });

    it('never builds the driver rows for a role that only sees aggregates', () => {
        const answer = buildDriverProductivity(rows, RoleEnum.COORDINATOR);
        expect(answer).toEqual({ detailRestricted: true, deliveredCount: 12, attemptCount: 16, drivers: [] });
        expect(JSON.stringify(answer)).not.toContain('Ana');
    });

    it('answers zeros and an empty list without closed dispatches', () => {
        expect(buildDriverProductivity([], RoleEnum.SUPERVISOR)).toEqual({ detailRestricted: false, deliveredCount: 0, attemptCount: 0, drivers: [] });
    });
});
