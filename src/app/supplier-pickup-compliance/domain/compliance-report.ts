import { OPERATING_TIME_ZONE } from '../../../modules/dispatch/dispatches/utils/operating-date.util.js';
import { AppointmentCategory, EXCEPTION_CATEGORIES, classifyAppointment } from './appointment-classifier.js';
import { buildComplianceMetrics, emptyCounts, originalExpiredBeforeReschedule, type CategoryCounts, type ComplianceMetrics } from './compliance-metrics.js';

/** Raw facts of one supplier pickup, as the repository reads them. This module is the only one that interprets them. */
export interface PickupAppointmentRow {
    dispatchId: number;
    status: string;
    purchaseOrderRef: string;
    supplierId: string | null;
    supplierName: string | null;
    destinationWarehouseId: number | null;
    /** Window in force. */
    windowStart: Date | null;
    windowEnd: Date | null;
    /** Window replaced by the first reschedule (the original appointment); null when never rescheduled. */
    originalWindowStart: Date | null;
    originalWindowEnd: Date | null;
    firstRescheduleAt: Date | null;
    custodyReceivedAt: Date | null;
    /** Arrival at the warehouse: shown, never used to measure compliance, and not the inventory receipt. */
    arrivedAtWarehouseAt: Date | null;
}

export interface ComplianceQuery {
    from: string;
    to: string;
    supplierId?: string;
    warehouseId?: number;
    zoneId?: number;
    status?: string;
}

export interface ComplianceException {
    dispatchId: number;
    category: AppointmentCategory;
    status: string;
    purchaseOrderRef: string;
    supplier: { id: string; name: string | null } | null;
    destinationWarehouseId: number | null;
    window: { start: string; end: string } | null;
    originalWindow: { start: string; end: string } | null;
    rescheduledAt: string | null;
    custodyReceivedAt: string | null;
    arrivedAtWarehouseAt: string | null;
}

export interface SupplierPickupComplianceReport {
    from: string;
    to: string;
    dateBasis: 'appointment_window_end';
    timeZone: string;
    asOf: string;
    filters: { supplierId: string | null; warehouseId: number | null; zoneId: number | null; status: string | null };
    metrics: ComplianceMetrics;
    counts: CategoryCounts;
    /** Appointments of the range that were rescheduled; they are measured against the window in force. */
    rescheduledCount: number;
    /** Rescheduled ones whose original window had already expired when the first reschedule was made. */
    originalExpiredBeforeRescheduleCount: number;
    exceptionsTotal: number;
    exceptions: ComplianceException[];
    empty: boolean;
}

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());
const range = (start: Date | null, end: Date | null) => (start !== null && end !== null ? { start: start.toISOString(), end: end.toISOString() } : null);

function toException(row: PickupAppointmentRow, category: AppointmentCategory): ComplianceException {
    return {
        dispatchId: row.dispatchId,
        category,
        status: row.status,
        purchaseOrderRef: row.purchaseOrderRef,
        supplier: row.supplierId === null ? null : { id: row.supplierId, name: row.supplierName },
        destinationWarehouseId: row.destinationWarehouseId,
        window: range(row.windowStart, row.windowEnd),
        originalWindow: range(row.originalWindowStart, row.originalWindowEnd),
        rescheduledAt: iso(row.firstRescheduleAt),
        custodyReceivedAt: iso(row.custodyReceivedAt),
        arrivedAtWarehouseAt: iso(row.arrivedAtWarehouseAt),
    };
}

/** Most overdue first (oldest window end); an exception with no usable window goes last, ties broken by id. */
function byOverdue(a: PickupAppointmentRow, b: PickupAppointmentRow): number {
    const ea = a.windowEnd?.getTime() ?? Number.POSITIVE_INFINITY;
    const eb = b.windowEnd?.getTime() ?? Number.POSITIVE_INFINITY;
    return ea - eb || a.dispatchId - b.dispatchId;
}

export function buildComplianceReport(query: ComplianceQuery, rows: readonly PickupAppointmentRow[], now: Date, exceptionLimit: number): SupplierPickupComplianceReport {
    const counts = emptyCounts();
    const exceptionRows: { row: PickupAppointmentRow; category: AppointmentCategory }[] = [];
    let rescheduledCount = 0;
    let originalExpiredCount = 0;

    for (const row of rows) {
        const category = classifyAppointment({ status: row.status, windowStart: row.windowStart, windowEnd: row.windowEnd, custodyReceivedAt: row.custodyReceivedAt }, now);
        counts[category] += 1;
        if (EXCEPTION_CATEGORIES.includes(category)) exceptionRows.push({ row, category });
        if (row.firstRescheduleAt !== null && category !== AppointmentCategory.CANCELLED) {
            rescheduledCount += 1;
            if (originalExpiredBeforeReschedule({ firstRescheduleAt: row.firstRescheduleAt, originalWindowEnd: row.originalWindowEnd })) originalExpiredCount += 1;
        }
    }

    exceptionRows.sort((a, b) => byOverdue(a.row, b.row));
    return {
        from: query.from,
        to: query.to,
        dateBasis: 'appointment_window_end',
        timeZone: OPERATING_TIME_ZONE,
        asOf: now.toISOString(),
        filters: { supplierId: query.supplierId ?? null, warehouseId: query.warehouseId ?? null, zoneId: query.zoneId ?? null, status: query.status ?? null },
        metrics: buildComplianceMetrics(counts),
        counts,
        rescheduledCount,
        originalExpiredBeforeRescheduleCount: originalExpiredCount,
        exceptionsTotal: exceptionRows.length,
        exceptions: exceptionRows.slice(0, exceptionLimit).map(({ row, category }) => toException(row, category)),
        empty: rows.length === 0,
    };
}
