/**
 * Builders shared by the specs of the plan generator. Not a spec itself (the name does not end in
 * `.spec.ts`), and excluded from the build by `**\/*spec.ts`.
 */
import { OsrmPort, type Coordinate, type DurationMatrix, type RouteResult, type TripResult } from '../../../plugins/osrm/osrm.port.js';
import { localInstant } from './operating-calendar.js';
import { parsePlanningSettings, type PlanningSettings, type RawSettings } from './planning-settings.js';
import type { OpenBatch, OpenBatchStop, PlanDispatch, PlanInput, PlanVehicle, PlanWarehouse } from './plan-types.js';

export const RAW_SETTINGS: RawSettings = {
    stop_service_minutes: '15',
    planning_margin_pct: '20',
    plan_working_days: '1,2,3,4,5',
    plan_non_working_dates: '2026-12-25',
    plan_min_orders_per_route: '3',
    service_min_operating_days: '2',
    service_max_operating_days: '3',
    route_cutoff_time: '15:00',
    promise_response_window_minutes: '720',
    slot_duration_minutes: '120',
    morning_window_start: '09:00',
    morning_window_end: '13:00',
    afternoon_window_start: '14:00',
    afternoon_window_end: '18:00',
    delivery_window_start: '08:00',
    delivery_window_end: '20:00',
};

export function settings(overrides: RawSettings = {}): PlanningSettings {
    const result = parsePlanningSettings({ ...RAW_SETTINGS, ...overrides });
    if (!result.values) throw new Error(`fixture settings are invalid: ${JSON.stringify(result)}`);
    return result.values;
}

/** Monday 2026-10-12 08:30 La Paz: the generator run of the simulated week. */
export const MONDAY_RUN = localInstant('2026-10-12', '08:30');
/** Confirmed Monday 08:00 → D2 is Wednesday 2026-10-14 and D3 is Thursday 2026-10-15. */
export const MONDAY_ORDER = localInstant('2026-10-12', '08:00');

export const DEPOT: Coordinate = { lat: -16.5, lon: -68.1 };

export const WAREHOUSE: PlanWarehouse = { warehouseId: 1, latitude: DEPOT.lat, longitude: DEPOT.lon };

/** A dispatch `km` away from the depot along a line, so the nearest-neighbour order is the km order. */
export function dispatch(id: number, overrides: Partial<PlanDispatch> & { km?: number } = {}): PlanDispatch {
    const { km = id, ...rest } = overrides;
    const zoneId = rest.zoneId ?? 1;
    return {
        dispatchId: id,
        zoneId,
        zoneCode: `ZON-${zoneId}`,
        zoneName: `Zona ${zoneId}`,
        zoneDeleted: false,
        warehouseId: 1,
        latitude: DEPOT.lat - km * 0.01,
        longitude: DEPOT.lon,
        priority: 'normal',
        orderConfirmedAt: MONDAY_ORDER,
        status: 'pending',
        fixedDate: null,
        agreedWindow: null,
        estimatedWeightKg: 10,
        packages: [],
        ...rest,
    };
}

export function vehicle(id: number, capacityKg: number, capacityM3 = 100, overrides: Partial<PlanVehicle> = {}): PlanVehicle {
    return {
        vehicleId: id,
        capacityKg,
        capacityM3,
        maxPackageLengthCm: null,
        maxPackageWidthCm: null,
        maxPackageHeightCm: null,
        ...overrides,
    };
}

export function planInput(overrides: Partial<PlanInput> = {}): PlanInput {
    return {
        now: MONDAY_RUN,
        settings: settings(),
        dispatches: [],
        vehicles: [vehicle(1, 1000)],
        driverIds: [10, 11, 12],
        warehouses: [WAREHOUSE],
        existingBatches: [],
        openBatches: [],
        ...overrides,
    };
}

/** OSRM double: 1 km of the fixtures (0.01 degrees) is 60 seconds of driving; one request is recorded per call. */
export class FakeOsrm extends OsrmPort {
    readonly calls: Coordinate[][] = [];
    failWith: Error | null = null;

    constructor(public tableMaxCoordinates = 100) {
        super();
    }

    async getDurationMatrix(coordinates: Coordinate[]): Promise<DurationMatrix> {
        this.calls.push(coordinates);
        if (this.failWith) throw this.failWith;
        return {
            durations: coordinates.map((from, i) => coordinates.map((to, j) =>
                i === j ? 0 : Math.round(Math.hypot(from.lat - to.lat, from.lon - to.lon) * 6_000))),
        };
    }

    async getOptimalTrip(): Promise<TripResult> {
        throw new Error('not used by the generator');
    }

    async getRoute(): Promise<RouteResult> {
        throw new Error('not used by the generator');
    }
}

/** A stop already in an open batch. `window` is [start, end] in local HH:mm on the batch date. */
export function openStop(
    date: string,
    id: number,
    sequence: number,
    over: Partial<PlanDispatch> & { km?: number; notified?: boolean; window?: [string, string] } = {},
): OpenBatchStop {
    const { notified = false, window, ...rest } = over;
    return {
        dispatch: dispatch(id, { status: notified ? 'scheduled' : 'in_planning', ...rest }),
        sequence,
        notified,
        window: window ? { start: localInstant(date, window[0]), end: localInstant(date, window[1]) } : null,
    };
}

export function openBatch(date: string, stops: OpenBatchStop[], over: Partial<OpenBatch> = {}): OpenBatch {
    return {
        routeBatchId: 500,
        version: 3,
        shiftDate: date,
        zoneId: 1,
        zoneCode: 'ZON-1',
        zoneName: 'Zona 1',
        warehouseId: 1,
        vehicleId: 1,
        stops,
        ...over,
    };
}
