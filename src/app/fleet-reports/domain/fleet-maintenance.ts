import type { FleetMaintenanceSummaryDto } from '../dto/fleet-availability.dto.js';

/**
 * One maintenance as Bolivia calendar days (`YYYY-MM-DD`, both ends included). `endDay` is null while the maintenance is
 * open: it counts through the end of the period, like ST-65.1.
 */
export interface MaintenanceInterval {
    vehicleId: number;
    startDay: string;
    endDay: string | null;
}

const MS_PER_DAY = 86_400_000;

const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / MS_PER_DAY);

/** Days of the interval inside the period, as a closed `[start, end]` pair of day numbers; null when it does not touch it. */
function clip(interval: MaintenanceInterval, from: string, to: string): [number, number] | null {
    const start = Math.max(dayNumber(interval.startDay), dayNumber(from));
    const end = Math.min(interval.endDay === null ? dayNumber(to) : dayNumber(interval.endDay), dayNumber(to));
    return start <= end ? [start, end] : null;
}

/**
 * Maintenance of one vehicle in the period: how many records touch it and how many calendar days it was in maintenance.
 * The days are the UNION of the intervals, so two overlapping records of one vehicle never count a day twice;
 * `overlapsDetected` says that happened (the records may need reconciliation). Adjacent intervals (one ends the day before
 * the next starts) share no day, so they are not an overlap. Pure.
 */
export function summarizeVehicleMaintenance(intervals: MaintenanceInterval[], from: string, to: string): FleetMaintenanceSummaryDto {
    const clipped = intervals.map((interval) => clip(interval, from, to)).filter((pair): pair is [number, number] => pair !== null);
    clipped.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let calendarDays = 0;
    let overlapsDetected = false;
    let current: [number, number] | null = null;
    for (const [start, end] of clipped) {
        if (current === null) {
            current = [start, end];
        } else if (start <= current[1]) {
            overlapsDetected = true;
            current[1] = Math.max(current[1], end);
        } else {
            calendarDays += current[1] - current[0] + 1;
            current = [start, end];
        }
    }
    if (current !== null) calendarDays += current[1] - current[0] + 1;
    return { count: clipped.length, calendarDays, overlapsDetected };
}

/** Maintenance by vehicle, plus the total of the vehicles given (the sum of their days: vehicle-days). */
export function summarizeFleetMaintenance(
    intervals: MaintenanceInterval[],
    vehicleIds: number[],
    from: string,
    to: string,
): { byVehicle: Map<number, FleetMaintenanceSummaryDto>; total: FleetMaintenanceSummaryDto } {
    const byVehicle = new Map<number, FleetMaintenanceSummaryDto>();
    for (const vehicleId of vehicleIds) {
        byVehicle.set(vehicleId, summarizeVehicleMaintenance(intervals.filter((interval) => interval.vehicleId === vehicleId), from, to));
    }
    const summaries = [...byVehicle.values()];
    return {
        byVehicle,
        total: {
            count: summaries.reduce((sum, item) => sum + item.count, 0),
            calendarDays: summaries.reduce((sum, item) => sum + item.calendarDays, 0),
            overlapsDetected: summaries.some((item) => item.overlapsDetected),
        },
    };
}
