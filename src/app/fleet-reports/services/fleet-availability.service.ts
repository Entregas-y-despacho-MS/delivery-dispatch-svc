import { Injectable } from '@nestjs/common';
import { todayInOperatingTimeZone } from '../../../modules/dispatch/dispatches/utils/operating-date.util.js';
import { summarizeAvailability, type FleetVehicleStatusRow } from '../domain/fleet-availability.js';
import { resolveCutoff } from '../domain/fleet-cutoff.js';
import { buildVehicleLoad } from '../domain/fleet-load.js';
import { summarizeFleetMaintenance } from '../domain/fleet-maintenance.js';
import { resolvePeriod } from '../domain/fleet-period.js';
import { buildDriverProductivity, canSeeDriverDetail } from '../domain/fleet-productivity.js';
import type { FleetAvailabilityCutoffDto, FleetAvailabilityDto, FleetAvailabilitySummaryDto, FleetLoadDto } from '../dto/fleet-availability.dto.js';
import type { FleetAvailabilityParamsDto } from '../dto/fleet-availability-params.dto.js';
import { DriverDetailForbiddenException } from '../exceptions/index.js';
import { FleetAvailabilityRepository } from '../repositories/fleet-availability.repository.js';

export interface FleetCutoffAvailability {
    cutoff: FleetAvailabilityCutoffDto;
    summary: FleetAvailabilitySummaryDto;
    /** Vehicles of the answer, `vehicleId` and `fleetStatus` applied. For a past cut-off: the registry as it is today (that day's status is N/D), empty if a status filter was asked. */
    vehicles: FleetVehicleStatusRow[];
}

/** Availability, maintenance, load and productivity of the fleet (ST-303.1), composed by `get`. */
@Injectable()
export class FleetAvailabilityService {
    constructor(private readonly repository: FleetAvailabilityRepository) {}

    /**
     * The summary counts every registered vehicle that passes the `vehicleId` filter, so assignable / registered keeps its
     * meaning; `fleetStatus` only narrows the list. A past cut-off has no stored state: the figures are N/D.
     */
    async atCutoff(params: Pick<FleetAvailabilityParamsDto, 'cutoff' | 'vehicleId' | 'fleetStatus'>, now: Date = new Date()): Promise<FleetCutoffAvailability> {
        const cutoff = resolveCutoff(params.cutoff, todayInOperatingTimeZone(now));
        const registered = await this.repository.listRegistered(params.vehicleId);
        if (cutoff.kind === 'past') {
            // The status of that day is not stored: no figures, and a status filter cannot be answered, so no list either.
            return { cutoff, summary: summarizeAvailability([], 'past'), vehicles: params.fleetStatus === undefined ? registered : [] };
        }
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

    /**
     * The whole answer of `GET /fleet/availability`. The role is checked FIRST (before any query): a role that may not see
     * drivers one by one cannot ask for one driver, and its driver rows are never built (ST-303.1, scenario 3).
     */
    async get(params: FleetAvailabilityParamsDto, role: string, now: Date = new Date()): Promise<FleetAvailabilityDto> {
        if (params.driverId !== undefined && !canSeeDriverDetail(role)) throw new DriverDetailForbiddenException();
        const answer = await this.atCutoff(params, now);
        const period = resolvePeriod(params.from, params.to, answer.cutoff.date);
        const vehicleIds = answer.vehicles.map((vehicle) => vehicle.vehicleId);
        const [maintenance, load, productivity] = await Promise.all([
            this.maintenance(vehicleIds, period, params),
            this.load(answer.vehicles, period),
            // A role without the driver detail gets the fleet-wide aggregate: narrowing it by vehicle would let it rebuild the
            // figures driver by driver (a vehicle has one driver per day).
            this.repository.listDriverProductivity(period.from, period.to, { vehicleId: canSeeDriverDetail(role) ? params.vehicleId : undefined, driverId: params.driverId }),
        ]);
        const past = answer.cutoff.kind === 'past';
        return {
            cutoff: answer.cutoff,
            from: period.from,
            to: period.to,
            units: { time: 'calendar_days', load: ['kg', 'm3'] },
            n: answer.vehicles.length,
            availability: answer.summary,
            maintenance: maintenance.total,
            vehicles: answer.vehicles.map((vehicle) => ({
                vehicleId: vehicle.vehicleId,
                plate: vehicle.plate,
                fleetStatus: past ? null : vehicle.status,
                maintenance: maintenance.byVehicle.get(vehicle.vehicleId)!,
                load: load.get(vehicle.vehicleId)!,
            })),
            productivity: buildDriverProductivity(productivity, role),
        };
    }

    /**
     * Load of each vehicle in the period, attributed only from its approved routes (see `listRouteLoads`). A vehicle
     * with no route answers N/D, never an inferred value.
     */
    async load(vehicles: FleetVehicleStatusRow[], period: { from: string; to: string }): Promise<Map<number, FleetLoadDto>> {
        const routes = vehicles.length === 0 ? [] : await this.repository.listRouteLoads(period.from, period.to, vehicles.map((v) => v.vehicleId));
        return new Map(vehicles.map((v) => [v.vehicleId, buildVehicleLoad(routes.filter((route) => route.vehicleId === v.vehicleId), v.capacityKg, v.capacityM3)]));
    }
}
