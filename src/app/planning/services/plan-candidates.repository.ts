import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RoleEnum, VehicleStatusEnum } from '../../../shared/enums/index.js';
import { addDays, fixedDateOfRescheduled } from '../domain/operating-calendar.js';
import type {
    ExistingBatchSummary,
    OpenBatch,
    OpenBatchStop,
    PlanDispatch,
    PlanVehicle,
    PlanWarehouse,
} from '../domain/plan-types.js';

interface CandidateRow {
    dispatch_id: number;
    delivery_zone_id: number;
    zone_code: string;
    zone_name: string;
    zone_deleted: boolean;
    origin_warehouse_id: number;
    delivery_latitude: string;
    delivery_longitude: string;
    priority: string;
    confirmed_at: Date;
    status: 'pending' | 'rescheduled';
    estimated_weight_kg: string | null;
    scheduled_window_start: Date | null;
    scheduled_window_end: Date | null;
    reschedule_window_start: Date | null;
    reschedule_window_end: Date | null;
}

interface OpenStopRow {
    route_batch_id: number;
    version: number;
    shift_date: string;
    delivery_zone_id: number;
    zone_code: string;
    zone_name: string;
    zone_deleted: boolean;
    origin_warehouse_id: number;
    vehicle_id: number;
    dispatch_id: number;
    sequence_order: number | null;
    status: string;
    priority: string;
    confirmed_at: Date;
    delivery_latitude: string | null;
    delivery_longitude: string | null;
    estimated_weight_kg: string | null;
    scheduled_window_start: Date | null;
    scheduled_window_end: Date | null;
    promise_notified_at: Date | null;
}

interface PackageRow {
    dispatch_id: number;
    dispatch_package_id: number;
    length_cm: string;
    width_cm: string;
    height_cm: string;
    gross_weight_kg: string;
}

/** What the generator reads before it decides anything. Read-only: nothing here writes. */
@Injectable()
export class PlanCandidatesRepository {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    /**
     * Deliveries the generator may plan: `pending`, or `rescheduled` without a batch, ready to ship,
     * with a point on the map, a zone and a warehouse. Orders a coordinator is editing (active soft
     * reservation, ST-48.2) are left alone, and `address_review` is out by status (D-19).
     * Queue order: urgent first (D-16, only orders the queue), then the oldest confirmation.
     */
    async findCandidates(): Promise<PlanDispatch[]> {
        const rows: CandidateRow[] = await this.dataSource.query(
            `SELECT d.dispatch_id, d.delivery_zone_id, z.code AS zone_code, z.name AS zone_name,
                    (z.deleted_at IS NOT NULL) AS zone_deleted, d.origin_warehouse_id,
                    d.delivery_latitude, d.delivery_longitude, d.priority,
                    COALESCE(d.order_confirmed_at, d.created_at) AS confirmed_at,
                    s.name AS status, d.estimated_weight_kg,
                    d.scheduled_window_start, d.scheduled_window_end,
                    lr.new_window_start AS reschedule_window_start, lr.new_window_end AS reschedule_window_end
               FROM dispatches d
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
               JOIN dispatch_types t ON t.dispatch_type_id = d.dispatch_type_id
               -- Not filtered by deleted_at: the promise runs from D0 and does not stop because the
               -- catalog changed; a deleted zone is planned and warned about.
               JOIN delivery_zones z ON z.delivery_zone_id = d.delivery_zone_id
          LEFT JOIN LATERAL (
                    SELECT r.new_window_start, r.new_window_end
                      FROM dispatch_reschedules r
                     WHERE r.dispatch_id = d.dispatch_id AND r.new_window_start IS NOT NULL
                     ORDER BY r.created_at DESC, r.dispatch_reschedule_id DESC
                     LIMIT 1
                    ) lr ON TRUE
              WHERE t.name = 'delivery'
                AND (s.name = 'pending' OR (s.name = 'rescheduled' AND d.route_batch_id IS NULL))
                AND d.shipment_ready = TRUE
                AND d.delivery_latitude IS NOT NULL AND d.delivery_longitude IS NOT NULL
                AND d.delivery_zone_id IS NOT NULL AND d.origin_warehouse_id IS NOT NULL
                AND NOT EXISTS (
                    SELECT 1 FROM dispatch_reservations rv
                     WHERE rv.dispatch_id = d.dispatch_id AND rv.expires_at > NOW())
              ORDER BY CASE WHEN d.priority = 'urgent' THEN 0 ELSE 1 END,
                       COALESCE(d.order_confirmed_at, d.created_at), d.dispatch_id`,
        );
        if (rows.length === 0) return [];

        const packagesByDispatch = await this.findPackages(rows.map((row) => row.dispatch_id));

        return rows.map((row) => ({
            dispatchId: row.dispatch_id,
            zoneId: row.delivery_zone_id,
            zoneCode: row.zone_code,
            zoneName: row.zone_name,
            zoneDeleted: row.zone_deleted,
            warehouseId: row.origin_warehouse_id,
            latitude: Number(row.delivery_latitude),
            longitude: Number(row.delivery_longitude),
            priority: row.priority,
            orderConfirmedAt: row.confirmed_at,
            status: row.status,
            fixedDate: row.status === 'rescheduled'
                ? fixedDateOfRescheduled(row.reschedule_window_start, row.scheduled_window_start)
                : null,
            // The window agreed with the customer (the reschedule's, else the one the order has).
            agreedWindow: row.status === 'rescheduled'
                ? agreedWindow(
                    row.reschedule_window_start ?? row.scheduled_window_start,
                    row.reschedule_window_start ? row.reschedule_window_end : row.scheduled_window_end,
                )
                : null,
            estimatedWeightKg: row.estimated_weight_kg === null ? null : Number(row.estimated_weight_kg),
            packages: packagesByDispatch.get(row.dispatch_id) ?? [],
        }));
    }

    /**
     * Provisional batches from today on, with their stops in visiting order: the ones a late order
     * may still be inserted into (the planner drops those whose cutoff has passed). A batch with a
     * stop that has no sequence or no point on the map is left out: it cannot be simulated.
     */
    async findOpenBatches(today: string): Promise<OpenBatch[]> {
        const rows: OpenStopRow[] = await this.dataSource.query(
            `SELECT b.route_batch_id, b.version, b.shift_date::text AS shift_date, b.delivery_zone_id,
                    z.code AS zone_code, z.name AS zone_name, (z.deleted_at IS NOT NULL) AS zone_deleted,
                    b.origin_warehouse_id, b.vehicle_id,
                    d.dispatch_id, d.sequence_order, s.name AS status, d.priority,
                    COALESCE(d.order_confirmed_at, d.created_at) AS confirmed_at,
                    d.delivery_latitude, d.delivery_longitude, d.estimated_weight_kg,
                    d.scheduled_window_start, d.scheduled_window_end, d.promise_notified_at
               FROM route_batches b
               JOIN delivery_zones z ON z.delivery_zone_id = b.delivery_zone_id
               JOIN dispatches d ON d.route_batch_id = b.route_batch_id
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
              WHERE b.status = 'provisional' AND b.shift_date >= $1::date
                AND b.vehicle_id IS NOT NULL AND b.origin_warehouse_id IS NOT NULL
              ORDER BY b.route_batch_id, d.sequence_order, d.dispatch_id`,
            [today],
        );
        if (rows.length === 0) return [];

        const packagesByDispatch = await this.findPackages(rows.map((row) => row.dispatch_id));
        const batches = new Map<number, { batch: OpenBatch; complete: boolean }>();
        for (const row of rows) {
            if (!batches.has(row.route_batch_id)) {
                batches.set(row.route_batch_id, {
                    complete: true,
                    batch: {
                        routeBatchId: row.route_batch_id,
                        version: row.version,
                        shiftDate: row.shift_date,
                        zoneId: row.delivery_zone_id,
                        zoneCode: row.zone_code,
                        zoneName: row.zone_name,
                        warehouseId: row.origin_warehouse_id,
                        vehicleId: row.vehicle_id,
                        stops: [],
                    },
                });
            }
            const entry = batches.get(row.route_batch_id)!;
            if (row.sequence_order === null || row.delivery_latitude === null || row.delivery_longitude === null) {
                entry.complete = false;
                continue;
            }
            const stop: OpenBatchStop = {
                dispatch: {
                    dispatchId: row.dispatch_id,
                    zoneId: row.delivery_zone_id,
                    zoneCode: row.zone_code,
                    zoneName: row.zone_name,
                    zoneDeleted: row.zone_deleted,
                    warehouseId: row.origin_warehouse_id,
                    latitude: Number(row.delivery_latitude),
                    longitude: Number(row.delivery_longitude),
                    priority: row.priority,
                    orderConfirmedAt: row.confirmed_at,
                    status: row.status === 'scheduled' ? 'scheduled' : 'in_planning',
                    fixedDate: null,
                    agreedWindow: null,
                    estimatedWeightKg: row.estimated_weight_kg === null ? null : Number(row.estimated_weight_kg),
                    packages: packagesByDispatch.get(row.dispatch_id) ?? [],
                },
                sequence: row.sequence_order,
                // D-10: once the customer was told the window, it is fixed.
                notified: row.promise_notified_at !== null,
                window: agreedWindow(row.scheduled_window_start, row.scheduled_window_end),
            };
            entry.batch.stops.push(stop);
        }

        return [...batches.values()]
            .filter((entry) => entry.complete && entry.batch.stops.length > 0)
            .map((entry) => entry.batch);
    }

    private async findPackages(dispatchIds: number[]): Promise<Map<number, PlanDispatch['packages']>> {
        const rows: PackageRow[] = await this.dataSource.query(
            `SELECT dispatch_id, dispatch_package_id, length_cm, width_cm, height_cm, gross_weight_kg
               FROM dispatch_packages
              WHERE dispatch_id = ANY($1)
              ORDER BY dispatch_id, dispatch_package_id`,
            [dispatchIds],
        );
        const byDispatch = new Map<number, PlanDispatch['packages']>();
        for (const pkg of rows) {
            if (!byDispatch.has(pkg.dispatch_id)) byDispatch.set(pkg.dispatch_id, []);
            byDispatch.get(pkg.dispatch_id)!.push({
                dispatchId: pkg.dispatch_id,
                packageId: pkg.dispatch_package_id,
                lengthCm: Number(pkg.length_cm),
                widthCm: Number(pkg.width_cm),
                heightCm: Number(pkg.height_cm),
                grossWeightKg: Number(pkg.gross_weight_kg),
            });
        }
        return byDispatch;
    }

    /** Active, not deleted vehicles with their capacities. */
    async findVehicles(): Promise<PlanVehicle[]> {
        const rows: Record<string, string | number | null>[] = await this.dataSource.query(
            `SELECT v.vehicle_id, v.capacity_kg, v.capacity_m3,
                    v.max_package_length_cm, v.max_package_width_cm, v.max_package_height_cm
               FROM vehicles v
               JOIN vehicle_statuses vs ON vs.vehicle_status_id = v.vehicle_status_id
              WHERE vs.name = $1 AND v.deleted_at IS NULL
              ORDER BY v.vehicle_id`,
            [VehicleStatusEnum.ACTIVE],
        );
        const numberOrNull = (value: string | number | null): number | null => (value === null ? null : Number(value));
        return rows.map((row) => ({
            vehicleId: Number(row.vehicle_id),
            capacityKg: Number(row.capacity_kg),
            capacityM3: Number(row.capacity_m3),
            maxPackageLengthCm: numberOrNull(row.max_package_length_cm),
            maxPackageWidthCm: numberOrNull(row.max_package_width_cm),
            maxPackageHeightCm: numberOrNull(row.max_package_height_cm),
        }));
    }

    /** Active, not deleted users with the driver role. */
    async findDriverIds(): Promise<number[]> {
        const rows: { user_id: number }[] = await this.dataSource.query(
            `SELECT u.user_id
               FROM users u
               JOIN roles r ON r.role_id = u.role_id
              WHERE r.name = $1 AND u.active = TRUE AND u.deleted_at IS NULL
              ORDER BY u.user_id`,
            [RoleEnum.DRIVER],
        );
        return rows.map((row) => row.user_id);
    }

    async findWarehouses(): Promise<PlanWarehouse[]> {
        const rows: { warehouse_id: number; latitude: string; longitude: string }[] = await this.dataSource.query(
            `SELECT warehouse_id, latitude, longitude
               FROM warehouses
              WHERE active = TRUE AND deleted_at IS NULL
              ORDER BY warehouse_id`,
        );
        return rows.map((row) => ({
            warehouseId: row.warehouse_id,
            latitude: Number(row.latitude),
            longitude: Number(row.longitude),
        }));
    }

    /**
     * Batches that are not cancelled, from a week back on: they hold their vehicle and driver for the
     * day and feed the weekly driver balance.
     */
    async findExistingBatches(today: string): Promise<ExistingBatchSummary[]> {
        const rows: { shift_date: string; vehicle_id: number | null; driver_id: number | null; proposed_driver_id: number | null }[] =
            await this.dataSource.query(
                `SELECT shift_date::text AS shift_date, vehicle_id, driver_id, proposed_driver_id
                   FROM route_batches
                  WHERE status <> 'cancelled' AND shift_date >= $1::date
                  ORDER BY route_batch_id`,
                [addDays(today, -7)],
            );
        return rows.map((row) => ({
            shiftDate: row.shift_date,
            vehicleId: row.vehicle_id,
            driverId: row.driver_id,
            proposedDriverId: row.proposed_driver_id,
        }));
    }
}

function agreedWindow(start: Date | null, end: Date | null): { start: Date; end: Date } | null {
    return start && end ? { start, end } : null;
}
