import { RoleEnum } from '../../../shared/enums/index.js';
import type { FleetDriverProductivityDto } from '../dto/fleet-availability.dto.js';

/** Dispatches closed in the period by the driver of their route; `driverId` is null for the ones without driver. */
export interface DriverProductivityRow {
    driverId: number | null;
    driverName: string | null;
    closedCount: number;
    deliveredCount: number;
}

/** Roles that see the figures driver by driver (name and id). The others only get the aggregate (ST-303.1, scenario 3). */
const DRIVER_DETAIL_ROLES: string[] = [RoleEnum.SUPERVISOR, RoleEnum.ROOT];

export function canSeeDriverDetail(role: string): boolean {
    return DRIVER_DETAIL_ROLES.includes(role);
}

/**
 * Deliveries and attempts (n) for the period. The totals count every closed dispatch, the ones without driver included;
 * the rows only the ones with a driver. The rows are dropped here, in the server, when the role may not see them: the
 * client never receives them to hide. Pure.
 */
export function buildDriverProductivity(rows: DriverProductivityRow[], role: string): FleetDriverProductivityDto {
    const detail = canSeeDriverDetail(role);
    return {
        detailRestricted: !detail,
        deliveredCount: rows.reduce((sum, row) => sum + row.deliveredCount, 0),
        attemptCount: rows.reduce((sum, row) => sum + row.closedCount, 0),
        drivers: detail
            ? rows.flatMap((row) => (row.driverId === null ? [] : [{ driverId: row.driverId, driverName: row.driverName, deliveredCount: row.deliveredCount, attemptCount: row.closedCount }]))
            : [],
    };
}
