import { VehicleStatusEnum } from '../../../shared/enums/index.js';
import { FleetUnavailableReason, type FleetAvailabilitySummaryDto } from '../dto/fleet-availability.dto.js';

/** A registered (not removed) vehicle and its current status. */
export interface FleetVehicleStatusRow {
    vehicleId: number;
    plate: string;
    status: VehicleStatusEnum;
    capacityKg: number;
    capacityM3: number;
}

/**
 * Assignable / registered at the cut-off, apart from maintenance and out of service. A vehicle counts in exactly one of
 * the three by its current status. For a past cut-off nothing is stored, so the four figures are `N/D` (null). Pure.
 */
export function summarizeAvailability(rows: FleetVehicleStatusRow[], kind: 'current' | 'past'): FleetAvailabilitySummaryDto {
    if (kind === 'past') {
        return { assignable: null, registered: null, inMaintenance: null, outOfService: null, unavailableReason: FleetUnavailableReason.NO_STATUS_HISTORY };
    }
    const count = (status: VehicleStatusEnum) => rows.filter((row) => row.status === status).length;
    return {
        assignable: count(VehicleStatusEnum.ACTIVE),
        registered: rows.length,
        inMaintenance: count(VehicleStatusEnum.MAINTENANCE),
        outOfService: count(VehicleStatusEnum.OUT_OF_SERVICE),
        unavailableReason: null,
    };
}
