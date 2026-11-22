import { FleetUnavailableReason, type FleetLoadDto, type FleetLoadFigureDto } from '../dto/fleet-availability.dto.js';

/**
 * What one approved route of a vehicle carries, from the estimates of its dispatches (cancelled ones excluded). A sum
 * only adds the dispatches that have the estimate; `withoutWeight` / `withoutVolume` count the ones that do not.
 */
export interface RouteLoad {
    routeBatchId: number;
    vehicleId: number;
    dispatches: number;
    weightKg: number;
    volumeM3: number;
    withoutWeight: number;
    withoutVolume: number;
}

function figure(used: number, capacity: number): FleetLoadFigureDto | null {
    if (!(capacity > 0)) return null;
    return { used, capacity, ratio: used / capacity };
}

/**
 * Load of one vehicle in the period (ST-303.1, RF "carga utilizada"), attributed ONLY from its approved routes: no route,
 * no load (`N/D`), never inferred from the vehicle's current status. A capacity applies to one trip, so the figure is the
 * heaviest route, not the sum of several days. kg and m³ are independent figures, each against its own capacity.
 * A figure with no dispatch carrying that estimate is `N/D` too. Pure.
 */
export function buildVehicleLoad(routes: RouteLoad[], capacityKg: number, capacityM3: number): FleetLoadDto {
    if (routes.length === 0) {
        return { kg: null, m3: null, routes: 0, n: 0, withoutWeight: 0, withoutVolume: 0, unavailableReason: FleetUnavailableReason.NO_ROUTE_IN_PERIOD };
    }
    const n = routes.reduce((sum, route) => sum + route.dispatches, 0);
    const withoutWeight = routes.reduce((sum, route) => sum + route.withoutWeight, 0);
    const withoutVolume = routes.reduce((sum, route) => sum + route.withoutVolume, 0);
    const kg = withoutWeight === n ? null : figure(Math.max(...routes.map((route) => route.weightKg)), capacityKg);
    const m3 = withoutVolume === n ? null : figure(Math.max(...routes.map((route) => route.volumeM3)), capacityM3);
    return {
        kg,
        m3,
        routes: routes.length,
        n,
        withoutWeight,
        withoutVolume,
        unavailableReason: kg === null && m3 === null ? FleetUnavailableReason.NO_ESTIMATE : null,
    };
}
