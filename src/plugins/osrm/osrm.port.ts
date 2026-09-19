export interface Coordinate {
    lat: number;
    lon: number;
}

export interface TripWaypoint {
    /** Index into the coordinates array passed to getOptimalTrip(). */
    inputIndex: number;
    /** Position in the optimized visiting order (0 = first stop). */
    order:      number;
}

export interface TripResult {
    waypoints:       TripWaypoint[];
    /** Encoded polyline (not raw GeoJSON) — matches route_batches.route_geometry (TEXT). */
    geometry:        string;
    distanceMeters:  number;
    durationSeconds: number;
}

export interface RouteResult {
    distanceMeters:  number;
    durationSeconds: number;
}

// Contract for the routing engine — independent of the underlying server.
// Consumers inject OsrmPort, never the concrete adapter.
export abstract class OsrmPort {
    /**
     * Optimal visiting order for a set of stops, starting from coordinates[0] (the depot/driver).
     * Used once per route_batches, not on every GPS ping — see plugins/osrm/CLAUDE.md-equivalent notes.
     */
    abstract getOptimalTrip(coordinates: Coordinate[]): Promise<TripResult>;

    /** Real street distance/duration between two points — used for on-demand ETA. */
    abstract getRoute(from: Coordinate, to: Coordinate): Promise<RouteResult>;
}
