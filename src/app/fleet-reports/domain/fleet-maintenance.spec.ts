import { describe, expect, it } from 'vitest';
import { summarizeFleetMaintenance, summarizeVehicleMaintenance, type MaintenanceInterval } from './fleet-maintenance.js';

const iv = (startDay: string, endDay: string | null, vehicleId = 1): MaintenanceInterval => ({ vehicleId, startDay, endDay });
const FROM = '2026-11-01';
const TO = '2026-11-30';

describe('summarizeVehicleMaintenance', () => {
    it('counts the calendar days of one interval, both ends included', () => {
        expect(summarizeVehicleMaintenance([iv('2026-11-03', '2026-11-05')], FROM, TO)).toEqual({ count: 1, calendarDays: 3, overlapsDetected: false });
    });

    it('clips an interval that crosses the period and counts an open one through the end', () => {
        expect(summarizeVehicleMaintenance([iv('2026-10-25', '2026-11-02')], FROM, TO).calendarDays).toBe(2);
        expect(summarizeVehicleMaintenance([iv('2026-11-28', null)], FROM, TO).calendarDays).toBe(3);
    });

    it('does not add a day twice when two intervals overlap, and says so', () => {
        const summary = summarizeVehicleMaintenance([iv('2026-11-03', '2026-11-08'), iv('2026-11-06', '2026-11-10')], FROM, TO);
        expect(summary).toEqual({ count: 2, calendarDays: 8, overlapsDetected: true });
    });

    it('handles an interval contained in another and intervals given out of order', () => {
        const summary = summarizeVehicleMaintenance([iv('2026-11-10', '2026-11-12'), iv('2026-11-01', '2026-11-20'), iv('2026-11-05', '2026-11-06')], FROM, TO);
        expect(summary).toEqual({ count: 3, calendarDays: 20, overlapsDetected: true });
    });

    it('does not call adjacent intervals an overlap (they share no day)', () => {
        const summary = summarizeVehicleMaintenance([iv('2026-11-03', '2026-11-05'), iv('2026-11-06', '2026-11-07')], FROM, TO);
        expect(summary).toEqual({ count: 2, calendarDays: 5, overlapsDetected: false });
    });

    it('treats intervals that share one single day as an overlap', () => {
        const summary = summarizeVehicleMaintenance([iv('2026-11-03', '2026-11-05'), iv('2026-11-05', '2026-11-07')], FROM, TO);
        expect(summary).toEqual({ count: 2, calendarDays: 5, overlapsDetected: true });
    });

    it('ignores an interval outside the period', () => {
        expect(summarizeVehicleMaintenance([iv('2026-10-01', '2026-10-31'), iv('2026-12-01', null)], FROM, TO)).toEqual({ count: 0, calendarDays: 0, overlapsDetected: false });
    });

    it('is zero without intervals', () => {
        expect(summarizeVehicleMaintenance([], FROM, TO)).toEqual({ count: 0, calendarDays: 0, overlapsDetected: false });
    });
});

describe('summarizeFleetMaintenance', () => {
    it('keeps each vehicle apart, gives zeros to the ones without maintenance and sums the total', () => {
        const intervals = [iv('2026-11-01', '2026-11-03', 1), iv('2026-11-02', '2026-11-04', 1), iv('2026-11-10', '2026-11-10', 2), iv('2026-11-01', '2026-11-30', 99)];
        const { byVehicle, total } = summarizeFleetMaintenance(intervals, [1, 2, 3], FROM, TO);
        expect(byVehicle.get(1)).toEqual({ count: 2, calendarDays: 4, overlapsDetected: true });
        expect(byVehicle.get(2)).toEqual({ count: 1, calendarDays: 1, overlapsDetected: false });
        expect(byVehicle.get(3)).toEqual({ count: 0, calendarDays: 0, overlapsDetected: false });
        expect(byVehicle.has(99)).toBe(false);
        expect(total).toEqual({ count: 3, calendarDays: 5, overlapsDetected: true });
    });

    it('does not mix the overlap of two different vehicles', () => {
        const { total } = summarizeFleetMaintenance([iv('2026-11-01', '2026-11-05', 1), iv('2026-11-03', '2026-11-08', 2)], [1, 2], FROM, TO);
        expect(total).toEqual({ count: 2, calendarDays: 11, overlapsDetected: false });
    });
});
