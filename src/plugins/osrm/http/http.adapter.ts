import { Injectable, Logger } from '@nestjs/common';
import { OsrmPort, Coordinate, TripResult, RouteResult } from '../osrm.port.js';
import { OsrmHttpConfig } from './http.config.js';
import { OsrmRequestException } from '../exceptions/index.js';

// coordinates are lon,lat in OSRM's own URL format — the opposite order of our Coordinate{ lat, lon }.
function toOsrmCoords(coordinates: Coordinate[]): string {
    return coordinates.map((c) => `${c.lon},${c.lat}`).join(';');
}

@Injectable()
export class OsrmHttpAdapter extends OsrmPort {
    private readonly logger = new Logger(OsrmHttpAdapter.name);

    constructor(private readonly config: OsrmHttpConfig) {
        super();
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

    private async request(url: string): Promise<any> {
        try {
            const response = await fetch(url);

            // fetch does not throw on 4xx/5xx — check response.ok manually.
            if (!response.ok) {
                const text = await response.text();
                this.logger.error(`OSRM error ${response.status}: ${text}`);
                throw new OsrmRequestException(`HTTP ${response.status}`);
            }

            const body = await response.json();
            if (body.code !== 'Ok') throw new OsrmRequestException(body.code);

            return body;
        } catch (err) {
            if (err instanceof OsrmRequestException) throw err;
            this.logger.error(`OSRM network error: ${err.message}`, err.stack);
            throw new OsrmRequestException(err.message);
        }
    }
}
