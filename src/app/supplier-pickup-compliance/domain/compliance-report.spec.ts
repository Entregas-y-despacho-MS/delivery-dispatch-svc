import { describe, expect, it } from 'vitest';
import { AppointmentCategory as C } from './appointment-classifier.js';
import { buildComplianceReport, type PickupAppointmentRow } from './compliance-report.js';

const NOW = new Date('2026-11-20T12:00:00Z');
const at = (iso: string) => new Date(iso);
const QUERY = { from: '2026-11-01', to: '2026-11-30' };

let nextId = 1;
const row = (overrides: Partial<PickupAppointmentRow> = {}): PickupAppointmentRow => ({
    dispatchId: nextId++,
    status: 'scheduled',
    purchaseOrderRef: 'PO-1',
    supplierId: 'SUP-1',
    supplierName: 'Acme',
    destinationWarehouseId: 1,
    windowStart: at('2026-11-18T14:00:00Z'),
    windowEnd: at('2026-11-18T16:00:00Z'),
    originalWindowStart: null,
    originalWindowEnd: null,
    firstRescheduleAt: null,
    custodyReceivedAt: null,
    arrivedAtWarehouseAt: null,
    ...overrides,
});

describe('buildComplianceReport', () => {
    it('matches the scenarios: future, on time, late and failed', () => {
        const rows = [
            row({ windowStart: at('2026-11-25T14:00:00Z'), windowEnd: at('2026-11-25T16:00:00Z') }),
            row({ status: 'picked_up_in_transit', custodyReceivedAt: at('2026-11-18T15:00:00Z') }),
            row({ status: 'picked_up_in_transit', custodyReceivedAt: at('2026-11-18T17:00:00Z') }),
            row({ status: 'incident' }),
        ];
        const report = buildComplianceReport(QUERY, rows, NOW, 50);
        expect(report.counts).toMatchObject({ [C.PENDING_NOT_DUE]: 1, [C.ON_TIME]: 1, [C.LATE]: 1, [C.FAILED]: 1 });
        expect(report.metrics).toMatchObject({ numerator: 1, denominator: 3, n: 3, percentage: 33.3 });
        expect(report.empty).toBe(false);
    });

    it('a missing custody timestamp is N/D with its cause, not a rate', () => {
        const report = buildComplianceReport(QUERY, [row({ status: 'delivered', custodyReceivedAt: null })], NOW, 50);
        expect(report.counts[C.UNKNOWN_TIMING]).toBe(1);
        expect(report.metrics).toMatchObject({ percentage: null, denominator: 0, unavailableReason: 'missing_timestamp' });
        expect(report.exceptions.map((e) => e.category)).toEqual([C.UNKNOWN_TIMING]);
    });

    it('no rows is empty and N/D', () => {
        const report = buildComplianceReport(QUERY, [], NOW, 50);
        expect(report.empty).toBe(true);
        expect(report.metrics).toMatchObject({ percentage: null, unavailableReason: 'no_valid_results' });
        expect(report.exceptions).toEqual([]);
    });

    it('lists failed, open overdue, late and N/D as exceptions, never completed or pending ones, most overdue first', () => {
        const rows = [
            row({ dispatchId: 10, status: 'picked_up_in_transit', custodyReceivedAt: at('2026-11-18T15:00:00Z') }),
            row({ dispatchId: 11, windowStart: at('2026-11-25T14:00:00Z'), windowEnd: at('2026-11-25T16:00:00Z') }),
            row({ dispatchId: 12, status: 'assigned', windowStart: at('2026-11-17T14:00:00Z'), windowEnd: at('2026-11-17T16:00:00Z') }),
            row({ dispatchId: 13, status: 'incident', windowStart: at('2026-11-10T14:00:00Z'), windowEnd: at('2026-11-10T16:00:00Z') }),
            row({ dispatchId: 14, status: 'cancelled' }),
        ];
        const report = buildComplianceReport(QUERY, rows, NOW, 50);
        expect(report.exceptions.map((e) => [e.dispatchId, e.category])).toEqual([[13, C.FAILED], [12, C.OPEN_OVERDUE]]);
        expect(report.exceptionsTotal).toBe(2);
    });

    it('open overdue pickups are not completed and stay out of the rate', () => {
        const report = buildComplianceReport(QUERY, [row({ status: 'in_transit' }), row({ status: 'picked_up_in_transit', custodyReceivedAt: at('2026-11-18T15:00:00Z') })], NOW, 50);
        expect(report.metrics).toMatchObject({ numerator: 1, denominator: 1, percentage: 100 });
        expect(report.counts[C.OPEN_OVERDUE]).toBe(1);
    });

    it('caps the list but reports the real total', () => {
        const rows = [1, 2, 3].map((n) => row({ dispatchId: 100 + n, status: 'incident' }));
        const report = buildComplianceReport(QUERY, rows, NOW, 2);
        expect(report.exceptions).toHaveLength(2);
        expect(report.exceptionsTotal).toBe(3);
    });

    it('keeps the original appointment and counts a reschedule made after the original expired apart', () => {
        const rescheduled = row({
            status: 'picked_up_in_transit', custodyReceivedAt: at('2026-11-18T15:00:00Z'),
            originalWindowStart: at('2026-11-10T14:00:00Z'), originalWindowEnd: at('2026-11-10T16:00:00Z'), firstRescheduleAt: at('2026-11-11T09:00:00Z'),
        });
        const early = row({
            status: 'incident', originalWindowStart: at('2026-11-17T14:00:00Z'), originalWindowEnd: at('2026-11-17T16:00:00Z'), firstRescheduleAt: at('2026-11-17T08:00:00Z'),
        });
        const cancelled = row({ status: 'cancelled', firstRescheduleAt: at('2026-11-11T09:00:00Z'), originalWindowEnd: at('2026-11-10T16:00:00Z') });
        const report = buildComplianceReport(QUERY, [rescheduled, early, cancelled], NOW, 50);
        expect(report.rescheduledCount).toBe(2);
        expect(report.originalExpiredBeforeRescheduleCount).toBe(1);
        expect(report.exceptions[0].originalWindow).toEqual({ start: '2026-11-17T14:00:00.000Z', end: '2026-11-17T16:00:00.000Z' });
        expect(report.exceptions[0].rescheduledAt).toBe('2026-11-17T08:00:00.000Z');
    });

    it('shows the arrival at the warehouse without using it to measure', () => {
        const report = buildComplianceReport(QUERY, [row({ status: 'in_transit', arrivedAtWarehouseAt: at('2026-11-18T15:00:00Z') })], NOW, 50);
        expect(report.counts[C.OPEN_OVERDUE]).toBe(1);
        expect(report.exceptions[0].arrivedAtWarehouseAt).toBe('2026-11-18T15:00:00.000Z');
        expect(report.exceptions[0].custodyReceivedAt).toBeNull();
    });

    it('repeats the filters, with null for what was not asked, plus the basis, zone and cut', () => {
        const report = buildComplianceReport({ ...QUERY, supplierId: 'SUP-9', warehouseId: 2 }, [], NOW, 50);
        expect(report).toMatchObject({
            from: '2026-11-01', to: '2026-11-30', dateBasis: 'appointment_window_end', timeZone: 'America/La_Paz', asOf: NOW.toISOString(),
            filters: { supplierId: 'SUP-9', warehouseId: 2, zoneId: null, status: null },
        });
    });
});
