import { Injectable, Logger } from '@nestjs/common';
import { OsrmPort, Coordinate, TripResult, RouteResult, DurationMatrix } from '../osrm.port.js';
import { OsrmHttpConfig } from './http.config.js';
import {
    OsrmRequestException,
    OsrmTableTooBigException,
    OsrmUnavailableException,
} from '../exceptions/index.js';

// coordinates are lon,lat in OSRM's own URL format — the opposite order of our Coordinate{ lat, lon }.
function toOsrmCoords(coordinates: Coordinate[]): string {
    return coordinates.map((c) => `${c.lon},${c.lat}`).join(';');
}

function range(from: number, to: number): number[] {
    return Array.from({ length: to - from }, (_, i) => from + i);
}

@Injectable()
export class OsrmHttpAdapter extends OsrmPort {
    private readonly logger = new Logger(OsrmHttpAdapter.name);

    constructor(private readonly config: OsrmHttpConfig) {
        super();
    }

    get tableMaxCoordinates(): number {
        return this.config.tableMaxCoordinates;
    }

    async getOptimalTrip(coordinates: Coordinate[]): Promise<TripResult> {
        const url =
            `${this.config.baseUrl}/trip/v1/driving/${toOsrmCoords(coordinates)}` +
            `?source=first&roundtrip=false&geometries=polyline&overview=full`;

        const body = await this.request(url);
        const trip = body.trips?.[0];
        if (!trip) throw new OsrmRequestException('OSRM returned no trip');

        return {
            waypoints: body.waypoints.map((w: any, inputIndex: number) => ({
                inputIndex,
                order: w.waypoint_index,
            })),
            geometry:        trip.geometry,
            distanceMeters:  trip.distance,
            durationSeconds: trip.duration,
        };
    }

    async getRoute(from: Coordinate, to: Coordinate): Promise<RouteResult> {
        const url = `${this.config.baseUrl}/route/v1/driving/${toOsrmCoords([from, to])}?overview=false`;

        const body = await this.request(url);
        const route = body.routes?.[0];
        if (!route) throw new OsrmRequestException('OSRM returned no route');

        return { distanceMeters: route.distance, durationSeconds: route.duration };
    }

    async getDurationMatrix(coordinates: Coordinate[]): Promise<DurationMatrix> {
        const n = coordinates.length;
        if (n === 0) return { durations: [] };
        if (n === 1) return { durations: [[0]] };

        const max = this.config.tableMaxCoordinates;
        if (n <= max) {
            return { durations: await this.tableBlock(coordinates, undefined, undefined, n, n) };
        }

        // OSRM's limit with explicit sources/destinations is `sources × destinations ≤ max²`
        // (measured, see osrm-limits.ts). Blocks of `max` rows × `max` columns always respect it
        // and, sending only the coordinates of the block, keep the URL short.
        const durations: (number | null)[][] = Array.from({ length: n }, () =>
            Array.from<number | null>({ length: n }).fill(null),
        );
        for (let r = 0; r < n; r += max) {
            const rows = coordinates.slice(r, r + max);
            for (let c = 0; c < n; c += max) {
                const cols = coordinates.slice(c, c + max);
                const block = await this.tableBlock(
                    [...rows, ...cols],
                    range(0, rows.length),
                    range(rows.length, rows.length + cols.length),
                    rows.length,
                    cols.length,
                );
                for (let i = 0; i < rows.length; i++) {
                    for (let j = 0; j < cols.length; j++) durations[r + i][c + j] = block[i][j];
                }
            }
        }
        return { durations };
    }

    private async tableBlock(
        coordinates: Coordinate[],
        sources: number[] | undefined,
        destinations: number[] | undefined,
        rows: number,
        cols: number,
    ): Promise<(number | null)[][]> {
        let query = 'annotations=duration';
        if (sources) query += `&sources=${sources.join(';')}`;
        if (destinations) query += `&destinations=${destinations.join(';')}`;
        const url = `${this.config.baseUrl}/table/v1/driving/${toOsrmCoords(coordinates)}?${query}`;

        const body = await this.request(url);
        const durations = body.durations;
        if (!Array.isArray(durations) || durations.length !== rows || durations.some((row: unknown) => !Array.isArray(row) || row.length !== cols)) {
            throw new OsrmRequestException('OSRM returned a table with an unexpected shape');
        }
        return durations;
    }

    private async request(url: string): Promise<any> {
        let response: Response;
        let text: string;
        try {
            response = await fetch(url, { signal: AbortSignal.timeout(this.config.timeoutMs) });
            text = await response.text();
        } catch (err) {
            // Timeout (TimeoutError/AbortError), refused connection, DNS...: the engine is not answering.
            this.logger.error(`OSRM unreachable: ${err.message}`);
            throw new OsrmUnavailableException(this.config.timeoutMs, err.message);
        }

        let body: any = null;
        try {
            body = JSON.parse(text);
        } catch {
            // Non-JSON body (a proxy error page): handled below by status.
        }

        // OSRM answers 4xx with a JSON `code` (TooBig, NoRoute, InvalidQuery...).
        if (body?.code === 'TooBig') throw new OsrmTableTooBigException(`HTTP ${response.status}`);

        if (response.status >= 500) {
            this.logger.error(`OSRM error ${response.status}: ${text.slice(0, 500)}`);
            throw new OsrmUnavailableException(this.config.timeoutMs, `HTTP ${response.status}`);
        }
        if (!response.ok || !body) {
            this.logger.error(`OSRM error ${response.status}: ${text.slice(0, 500)}`);
            throw new OsrmRequestException(body?.code ?? `HTTP ${response.status}`);
        }
        if (body.code !== 'Ok') throw new OsrmRequestException(body.code);

        return body;
    }
}
