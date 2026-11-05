import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CacheService } from '../../../plugins/cache/cache.port.js';
import { CacheUnavailableException } from '../../../plugins/cache/exceptions/index.js';
import { OsrmRequestException, OsrmTableTooBigException, OsrmUnavailableException } from '../../../plugins/osrm/exceptions/index.js';
import { OsrmPort, type Coordinate } from '../../../plugins/osrm/osrm.port.js';
import { DispatchStatusEnum } from '../../../shared/enums/dispatch-status.enum.js';
import { ETA_CACHE_TTL_SECONDS, buildEtaPath, minutesToWindowEnd, pathSeconds, secondsToMinutes } from '../domain/eta.js';
import type { EtaDto, EtaSource } from '../dto/public-tracking.dto.js';

export const ETA_CACHE_PREFIX = 'tracking:eta:';

/** What the estimate needs from the dispatch the customer is looking at. */
export interface EtaSubject {
    dispatchId: number;
    status: string;
    routeBatchId: number | null;
    windowEnd: Date | null;
}

interface StopRow {
    dispatch_id: number;
    delivery_latitude: string | null;
    delivery_longitude: string | null;
}

interface PositionRow {
    last_latitude: string;
    last_longitude: string;
}

/**
 * Estimated arrival for the customer's page (ST-40.1, RF-U15, RF-U17).
 *
 * Driving time from the driver's last known position, through the pending stops before this order, to the
 * customer. The estimate is kept 60 s per delivery in the cache, whatever its source, so a page that asks every
 * 30 s neither loads OSRM nor waits for its timeout again while OSRM is down.
 *
 * It never fails the page: OSRM down, no position yet, no coordinates, no route between two points or an
 * unreachable cache all end in `source: window` (the promised slot) or in a calculation without the cache.
 */
@Injectable()
export class TrackingEtaService {
    private readonly logger = new Logger(TrackingEtaService.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly osrm: OsrmPort,
        private readonly cache: CacheService,
    ) {}

    /** `null` when there is nothing to say: not on the road yet, or no estimate and no slot to fall back on. */
    async estimate(subject: EtaSubject, now: Date = new Date()): Promise<EtaDto | null> {
        if (!isOnTheRoad(subject.status) || subject.routeBatchId === null) return null;

        const key = `${ETA_CACHE_PREFIX}${subject.dispatchId}`;
        const cached = await this.read(key);
        if (cached) return cached;

        const eta = await this.calculate(subject, now);
        if (eta) await this.write(key, eta);
        return eta;
    }

    private async calculate(subject: EtaSubject, now: Date): Promise<EtaDto | null> {
        const seconds = await this.drivingSeconds(subject);
        if (seconds !== null) return { minutes: secondsToMinutes(seconds), calculatedAt: now, source: 'osrm' };

        const minutes = minutesToWindowEnd(subject.windowEnd, now);
        return minutes === null ? null : { minutes, calculatedAt: now, source: 'window' };
    }

    /** `null` for anything that stops OSRM from giving an honest number. */
    private async drivingSeconds(subject: EtaSubject): Promise<number | null> {
        const path = await this.path(subject);
        if (!path) return null;
        try {
            const { durations } = await this.osrm.getDurationMatrix(path);
            return pathSeconds(durations, path.length);
        } catch (error) {
            if (error instanceof OsrmUnavailableException || error instanceof OsrmRequestException || error instanceof OsrmTableTooBigException) {
                this.logger.warn(`ETA of dispatch ${subject.dispatchId} falls back to the slot: ${error.message}`);
                return null;
            }
            throw error;
        }
    }

    private async path(subject: EtaSubject): Promise<Coordinate[] | null> {
        const [position]: PositionRow[] = await this.dataSource.query(
            `SELECT last_latitude, last_longitude
               FROM dispatches
              WHERE route_batch_id = $1 AND last_location_at IS NOT NULL
                AND last_latitude IS NOT NULL AND last_longitude IS NOT NULL
              ORDER BY last_location_at DESC
              LIMIT 1`,
            [subject.routeBatchId],
        );
        if (!position) return null;

        // The pending stops up to this one, in visiting order; this order is the last row.
        const stops: StopRow[] = await this.dataSource.query(
            `SELECT d.dispatch_id, d.delivery_latitude, d.delivery_longitude
               FROM dispatches d
               JOIN dispatch_statuses ds ON ds.dispatch_status_id = d.dispatch_status_id
              WHERE d.route_batch_id = $1
                AND d.sequence_order IS NOT NULL
                AND d.sequence_order <= (SELECT sequence_order FROM dispatches WHERE dispatch_id = $2)
                AND ds.name IN ($3, $4)
              ORDER BY d.sequence_order`,
            [subject.routeBatchId, subject.dispatchId, DispatchStatusEnum.OUT_FOR_DELIVERY, DispatchStatusEnum.IN_TRANSIT],
        );
        const own = stops.at(-1);
        if (!own || own.dispatch_id !== subject.dispatchId) return null;
        const destination = toCoordinate(own.delivery_latitude, own.delivery_longitude);
        const driver = toCoordinate(position.last_latitude, position.last_longitude);
        if (!destination || !driver) return null;

        const before = stops.slice(0, -1).map((stop) => toCoordinate(stop.delivery_latitude, stop.delivery_longitude));
        return buildEtaPath(driver, before, destination);
    }

    /** A broken or unreachable cache is a miss, never an error for the customer. */
    private async read(key: string): Promise<EtaDto | null> {
        try {
            const raw = await this.cache.get(key);
            return raw === null ? null : parseEta(raw);
        } catch (error) {
            if (error instanceof CacheUnavailableException) return null;
            throw error;
        }
    }

    private async write(key: string, eta: EtaDto): Promise<void> {
        try {
            await this.cache.setWithTtl(key, JSON.stringify(eta), ETA_CACHE_TTL_SECONDS);
        } catch (error) {
            if (!(error instanceof CacheUnavailableException)) throw error;
        }
    }
}

function isOnTheRoad(status: string): boolean {
    return status === DispatchStatusEnum.OUT_FOR_DELIVERY || status === DispatchStatusEnum.IN_TRANSIT;
}

/** NUMERIC columns come back from the driver as strings. */
function toCoordinate(latitude: string | null, longitude: string | null): Coordinate | null {
    if (latitude === null || longitude === null) return null;
    const lat = Number(latitude);
    const lon = Number(longitude);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

const SOURCES: EtaSource[] = ['osrm', 'window'];

/** An entry that is not exactly what `write` stores (an old format, a partial write) is ignored. */
function parseEta(raw: string): EtaDto | null {
    try {
        const value = JSON.parse(raw) as Partial<Record<keyof EtaDto, unknown>>;
        const calculatedAt = new Date(String(value.calculatedAt));
        if (typeof value.minutes !== 'number' || !Number.isFinite(value.minutes) || value.minutes < 0) return null;
        if (!SOURCES.includes(value.source as EtaSource) || Number.isNaN(calculatedAt.getTime())) return null;
        return { minutes: value.minutes, calculatedAt, source: value.source as EtaSource };
    } catch {
        return null;
    }
}
