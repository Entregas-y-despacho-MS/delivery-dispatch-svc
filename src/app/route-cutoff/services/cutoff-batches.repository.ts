import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { PlanDispatch } from '../../planning/domain/plan-types.js';
import type { CutoffBatch, CutoffStop } from '../domain/cutoff-types.js';

interface StopRow {
    route_batch_id: number;
    batch_version: number;
    shift_date: string;
    delivery_zone_id: number;
    zone_code: string;
    zone_name: string;
    zone_deleted: boolean;
    origin_warehouse_id: number;
    vehicle_id: number | null;
    proposed_driver_id: number | null;
    reviewer_user_id: number | null;
    dispatch_id: number;
    dispatch_version: number;
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
    promise_firmed_at: Date | null;
}

interface PackageRow {
    dispatch_id: number;
    dispatch_package_id: number;
    length_cm: string;
    width_cm: string;
    height_cm: string;
    gross_weight_kg: string;
}

export interface CutoffBatchesRead {
    batches: CutoffBatch[];
    /** Batches with a stop that has no sequence or no point on the map: the cutoff cannot simulate them. */
    skippedBatchIds: number[];
}

/** What the cutoff reads before it decides anything. Read-only: nothing here writes. */
@Injectable()
export class CutoffBatchesRepository {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    /** The `provisional` batches of `shiftDate` with their stops in visiting order. */
    async findProvisionalBatches(shiftDate: string): Promise<CutoffBatchesRead> {
        const rows: StopRow[] = await this.dataSource.query(
            `SELECT b.route_batch_id, b.version AS batch_version, b.shift_date::text AS shift_date,
                    b.delivery_zone_id, z.code AS zone_code, z.name AS zone_name,
                    (z.deleted_at IS NOT NULL) AS zone_deleted, b.origin_warehouse_id,
                    b.vehicle_id, b.proposed_driver_id, b.reviewer_user_id,
                    d.dispatch_id, d.version AS dispatch_version, d.sequence_order, s.name AS status, d.priority,
                    COALESCE(d.order_confirmed_at, d.created_at) AS confirmed_at,
                    d.delivery_latitude, d.delivery_longitude, d.estimated_weight_kg,
                    d.scheduled_window_start, d.scheduled_window_end,
                    d.promise_notified_at, d.promise_firmed_at
               FROM route_batches b
               JOIN delivery_zones z ON z.delivery_zone_id = b.delivery_zone_id
               JOIN dispatches d ON d.route_batch_id = b.route_batch_id
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
              WHERE b.status = 'provisional' AND b.shift_date = $1::date
                AND b.origin_warehouse_id IS NOT NULL
              ORDER BY b.route_batch_id, d.sequence_order, d.dispatch_id`,
            [shiftDate],
        );
        if (rows.length === 0) return { batches: [], skippedBatchIds: [] };

        const packages = await this.findPackages(rows.map((row) => row.dispatch_id));
        const byBatch = new Map<number, { batch: CutoffBatch; complete: boolean }>();
        for (const row of rows) {
            if (!byBatch.has(row.route_batch_id)) {
                byBatch.set(row.route_batch_id, {
                    complete: true,
                    batch: {
                        routeBatchId: row.route_batch_id,
                        version: row.batch_version,
                        shiftDate: row.shift_date,
                        zoneId: row.delivery_zone_id,
                        zoneCode: row.zone_code,
                        zoneName: row.zone_name,
                        warehouseId: row.origin_warehouse_id,
                        vehicleId: row.vehicle_id,
                        proposedDriverId: row.proposed_driver_id,
                        reviewerUserId: row.reviewer_user_id,
                        stops: [],
                    },
                });
            }
            const entry = byBatch.get(row.route_batch_id)!;
            if (row.sequence_order === null || row.delivery_latitude === null || row.delivery_longitude === null) {
                entry.complete = false;
                continue;
            }
            const dispatch: PlanDispatch = {
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
                packages: packages.get(row.dispatch_id) ?? [],
            };
            const stop: CutoffStop = {
                dispatch,
                sequence: row.sequence_order,
                version: row.dispatch_version,
                promiseNotifiedAt: row.promise_notified_at,
                promiseFirmedAt: row.promise_firmed_at,
                window: row.scheduled_window_start && row.scheduled_window_end
                    ? { start: row.scheduled_window_start, end: row.scheduled_window_end }
                    : null,
            };
            entry.batch.stops.push(stop);
        }

        const batches: CutoffBatch[] = [];
        const skippedBatchIds: number[] = [];
        for (const { batch, complete } of byBatch.values()) {
            if (complete && batch.stops.length > 0) batches.push(batch);
            else skippedBatchIds.push(batch.routeBatchId);
        }
        return { batches, skippedBatchIds };
    }

    /** Vehicles held on `shiftDate` by batches the cutoff is not processing (any status but `cancelled`). */
    async findOccupiedVehicleIds(shiftDate: string, processedBatchIds: number[]): Promise<number[]> {
        const rows: { vehicle_id: number }[] = await this.dataSource.query(
            `SELECT DISTINCT vehicle_id
               FROM route_batches
              WHERE shift_date = $1::date AND status <> 'cancelled' AND vehicle_id IS NOT NULL
                AND route_batch_id <> ALL($2::int[])`,
            [shiftDate, processedBatchIds],
        );
        return rows.map((row) => row.vehicle_id);
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
}
