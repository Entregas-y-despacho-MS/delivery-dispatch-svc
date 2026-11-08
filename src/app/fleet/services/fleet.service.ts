import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { FleetLivePositionDto } from '../dto/live-position.dto.js';
import { OPEN_ROUTE_DISPATCH_STATUSES } from '../../route-batch-closing/services/route-batch-closing.service.js';

interface LivePositionRow {
    route_batch_id: number;
    driver_id: number;
    driver_full_name: string;
    vehicle_id: number;
    vehicle_plate: string;
    zone_id: number | null;
    zone_name: string | null;
    current_dispatch_id: number | null;
    current_tracking_code: string | null;
    current_status: string | null;
    last_latitude: number | null;
    last_longitude: number | null;
    last_location_at: Date | null;
}

// RF-A13 — one row per route batch in execution, for the Supervisor/Coordinator live fleet map.
@Injectable()
export class FleetService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    /**
     * The "current stop" prefers the one already `in_transit`; if none is (between stops, or the
     * driver hasn't started the next leg yet), it falls back to the next open one by visit order
     * (`dispatch_id` breaks a tie on `sequence_order`, so the result is deterministic). The position
     * is always the most recent GPS point of any stop in the batch (`lastpos`), never the current
     * stop's own point specifically — a stop that went back to an earlier status (e.g. `assigned`
     * again after an incident) can hold an older point than one already worked, and "last known
     * position of the vehicle" must still be the newest one, not that stop's.
     */
    async findLivePositions(): Promise<FleetLivePositionDto[]> {
        const rows: LivePositionRow[] = await this.dataSource.query(
            `SELECT
                 rb.route_batch_id AS route_batch_id,
                 rb.driver_id AS driver_id,
                 u.full_name AS driver_full_name,
                 rb.vehicle_id AS vehicle_id,
                 v.plate AS vehicle_plate,
                 rb.delivery_zone_id AS zone_id,
                 dz.name AS zone_name,
                 cur.dispatch_id AS current_dispatch_id,
                 cur.tracking_code AS current_tracking_code,
                 cur.status_name AS current_status,
                 lastpos.last_latitude AS last_latitude,
                 lastpos.last_longitude AS last_longitude,
                 lastpos.last_location_at AS last_location_at
               FROM route_batches rb
               JOIN users u ON u.user_id = rb.driver_id
               JOIN vehicles v ON v.vehicle_id = rb.vehicle_id
               LEFT JOIN delivery_zones dz ON dz.delivery_zone_id = rb.delivery_zone_id
               LEFT JOIN LATERAL (
                   SELECT d.dispatch_id, d.tracking_code, ds.name AS status_name
                     FROM dispatches d
                     JOIN dispatch_statuses ds ON ds.dispatch_status_id = d.dispatch_status_id
                    WHERE d.route_batch_id = rb.route_batch_id
                      AND ds.name = ANY($1::text[])
                    ORDER BY (ds.name = 'in_transit') DESC, d.sequence_order ASC NULLS LAST, d.dispatch_id ASC
                    LIMIT 1
               ) cur ON true
               LEFT JOIN LATERAL (
                   SELECT d.last_latitude, d.last_longitude, d.last_location_at
                     FROM dispatches d
                    WHERE d.route_batch_id = rb.route_batch_id AND d.last_location_at IS NOT NULL
                    ORDER BY d.last_location_at DESC
                    LIMIT 1
               ) lastpos ON true
              WHERE rb.status = 'in_execution'
              ORDER BY rb.route_batch_id ASC`,
            [OPEN_ROUTE_DISPATCH_STATUSES],
        );

        return rows.map((row) => ({
            routeBatchId:   row.route_batch_id,
            driverId:       row.driver_id,
            driverFullName: row.driver_full_name,
            vehicleId:      row.vehicle_id,
            vehiclePlate:   row.vehicle_plate,
            deliveryZone:   row.zone_id === null ? null : { id: row.zone_id, name: row.zone_name! },
            currentStop:    row.current_dispatch_id === null ? null : {
                dispatchId:   row.current_dispatch_id,
                trackingCode: row.current_tracking_code,
                status:       row.current_status!,
            },
            lastLatitude:   row.last_latitude === null ? null : Number(row.last_latitude),
            lastLongitude:  row.last_longitude === null ? null : Number(row.last_longitude),
            lastLocationAt: row.last_location_at === null ? null : new Date(row.last_location_at).toISOString(),
        }));
    }
}
