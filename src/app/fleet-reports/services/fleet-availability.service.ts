import { Injectable } from '@nestjs/common';
import { todayInOperatingTimeZone } from '../../../modules/dispatch/dispatches/utils/operating-date.util.js';
import { summarizeAvailability, type FleetVehicleStatusRow } from '../domain/fleet-availability.js';
import { resolveCutoff } from '../domain/fleet-cutoff.js';
import { summarizeFleetMaintenance } from '../domain/fleet-maintenance.js';
import type { FleetAvailabilityCutoffDto, FleetAvailabilitySummaryDto } from '../dto/fleet-availability.dto.js';
import type { FleetAvailabilityParamsDto } from '../dto/fleet-availability-params.dto.js';
import { FleetAvailabilityRepository } from '../repositories/fleet-availability.repository.js';

export interface FleetCutoffAvailability {
    cutoff: FleetAvailabilityCutoffDto;
    summary: FleetAvailabilitySummaryDto;
    /** Vehicles of the answer: the `vehicleId` and `fleetStatus` filters applied. Empty for a past cut-off. */
    vehicles: FleetVehicleStatusRow[];
}

/** Availability at the cut-off (ST-303.1, step 2). The endpoint composes it with maintenance, load and role in later steps. */
@Injectable()
export class FleetAvailabilityService {
    constructor(private readonly repository: FleetAvailabilityRepository) {}

    /**
     * The summary counts every registered vehicle that passes the `vehicleId` filter, so assignable / registered keeps its
     * meaning; `fleetStatus` only narrows the list. A past cut-off has no stored state: no figures and no list (N/D).
     */
    async atCutoff(params: Pick<FleetAvailabilityParamsDto, 'cutoff' | 'vehicleId' | 'fleetStatus'>, now: Date = new Date()): Promise<FleetCutoffAvailability> {
        const cutoff = resolveCutoff(params.cutoff, todayInOperatingTimeZone(now));
        if (cutoff.kind === 'past') return { cutoff, summary: summarizeAvailability([], 'past'), vehicles: [] };
        const registered = await this.repository.listRegistered(params.vehicleId);
        return {
            cutoff,
            summary: summarizeAvailability(registered, 'current'),
            vehicles: params.fleetStatus === undefined ? registered : registered.filter((row) => row.status === params.fleetStatus),
        };
    }

    /**
     * Maintenance of the given vehicles in the period (Bolivia days). It does not depend on the cut-off: maintenance
     * records carry their own dates, so a past period is real data, unlike the vehicle status.
     */
    async maintenance(
        vehicleIds: number[],
        period: { from: string; to: string },
        filter: Pick<FleetAvailabilityParamsDto, 'maintenanceTypeId' | 'routine'>,
    ): Promise<ReturnType<typeof summarizeFleetMaintenance>> {
        if (vehicleIds.length === 0) return summarizeFleetMaintenance([], [], period.from, period.to);
        const intervals = await this.repository.listMaintenanceIntervals(period.from, period.to, { vehicleIds, maintenanceTypeId: filter.maintenanceTypeId, routine: filter.routine });
        return summarizeFleetMaintenance(intervals, vehicleIds, period.from, period.to);
    }
}
