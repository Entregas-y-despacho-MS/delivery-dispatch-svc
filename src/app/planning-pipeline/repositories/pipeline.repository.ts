import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
    calculateRouteCapacity,
    type RouteCapacityDispatch,
    type VehicleCapacity,
} from '../../../modules/dispatch/route-batches/domain/route-capacity.js';
import { toPipelineCapacity, type PipelineCapacity } from '../domain/pipeline-capacity.js';
import type { PipelineShift } from '../dto/planning-pipeline-params.dto.js';

/** Statuses a dispatch can have while it is part of the pipeline (the others are finished, cancelled, returned or in incident). */
export const PIPELINE_STATUSES = ['address_review', 'pending', 'rescheduled', 'pickup_scheduled', 'in_planning', 'scheduled', 'assigned', 'out_for_delivery', 'in_transit'] as const;

/** The first hour of the afternoon shift (America/La_Paz). There is no shift table (D-20): the shift comes from the start of the promise window. */
export const AFTERNOON_SHIFT_START_HOUR = 12;

export interface PipelineFilters {
    /** Operating day, YYYY-MM-DD. */
    date: string;
    zoneId?: number;
    warehouseId?: number;
    shift?: PipelineShift;
}

export interface PipelineCandidate {
    dispatchId: number;
    status: string;
    priority: string;
    windowStart: Date | null;
    routeBatchId: number | null;
    batchStatus: string | null;
    batchVersion: number | null;
    batchShiftDate: string | null;
    zone: { id: number; name: string } | null;
    warehouse: { id: number; name: string } | null;
    operatingDate: string | null;
    shift: PipelineShift | null;
    vehicle: { id: number; name: string } | null;
    driver: { id: number; name: string } | null;
    /** Reason of the latest `plan_exception` with no status change after it, `null` when there is none (a solved exception is not returned). */
    planExceptionReason: string | null;
    planExceptionDetail: string | null;
}

export interface BatchLoad {
    /** Capacity of the vehicle against the load, `null` when the batch has no vehicle. */
    capacity: PipelineCapacity | null;
    /** Dispatches of the batch (any status), the load the vehicle really carries. */
    dispatchCount: number;
}

interface CandidateRow {
    dispatch_id: number;
    status: string;
    priority: string;
    window_start: Date | null;
    route_batch_id: number | null;
    batch_status: string | null;
    batch_version: number | null;
    batch_shift_date: string | null;
    zone_id: number | null;
    zone_name: string | null;
    warehouse_id: number | null;
    warehouse_name: string | null;
    operating_date: string | null;
    shift: PipelineShift | null;
    vehicle_id: number | null;
    vehicle_plate: string | null;
    driver_id: number | null;
    driver_name: string | null;
    plan_reason: string | null;
    plan_detail: string | null;
}

interface BatchVehicleRow {
    route_batch_id: number;
    vehicle_id: number | null;
    capacity_kg: string | null;
    capacity_m3: string | null;
    max_package_length_cm: string | null;
    max_package_width_cm: string | null;
    max_package_height_cm: string | null;
}

interface BatchLoadRow {
    route_batch_id: number;
    dispatch_id: number;
    estimated_weight_kg: string | null;
    estimated_volume_m3: string | null;
    package_id: number | null;
    length_cm: string | null;
    width_cm: string | null;
    height_cm: string | null;
    gross_weight_kg: string | null;
}

/**
 * The dispatches of an operating day that are in the planning pipeline. A dispatch with a batch belongs to the
 * day of its batch (`shift_date`); one without batch, to the day of its promise window. A dispatch without
 * batch and without window is open work that carries over: it shows from the day it was created on.
 */
export const PIPELINE_CANDIDATES_SQL = `
    WITH candidate AS (
        SELECT d.dispatch_id, s.name AS status, d.priority, d.scheduled_window_start AS window_start,
               rb.route_batch_id, rb.status AS batch_status, rb.version AS batch_version,
               to_char(rb.shift_date, 'YYYY-MM-DD') AS batch_shift_date,
               COALESCE(d.delivery_zone_id, rb.delivery_zone_id) AS zone_id, z.name AS zone_name,
               COALESCE(rb.origin_warehouse_id, d.origin_warehouse_id) AS warehouse_id, w.name AS warehouse_name,
               to_char(COALESCE(rb.shift_date, (d.scheduled_window_start AT TIME ZONE 'America/La_Paz')::date), 'YYYY-MM-DD') AS operating_date,
               CASE WHEN d.scheduled_window_start IS NULL THEN NULL
                    WHEN EXTRACT(HOUR FROM d.scheduled_window_start AT TIME ZONE 'America/La_Paz') < ${AFTERNOON_SHIFT_START_HOUR} THEN 'morning'
                    ELSE 'afternoon' END AS shift,
               v.vehicle_id, v.plate AS vehicle_plate,
               driver.user_id AS driver_id, driver.full_name AS driver_name,
               pe.reason AS plan_reason, pe.detail AS plan_detail,
               (d.created_at AT TIME ZONE 'America/La_Paz')::date AS created_day
          FROM dispatches d
          JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
          LEFT JOIN route_batches rb ON rb.route_batch_id = d.route_batch_id
          LEFT JOIN delivery_zones z ON z.delivery_zone_id = COALESCE(d.delivery_zone_id, rb.delivery_zone_id)
          LEFT JOIN warehouses w ON w.warehouse_id = COALESCE(rb.origin_warehouse_id, d.origin_warehouse_id)
          LEFT JOIN vehicles v ON v.vehicle_id = rb.vehicle_id AND v.deleted_at IS NULL
          LEFT JOIN users driver ON driver.user_id = COALESCE(rb.driver_id, rb.proposed_driver_id)
          LEFT JOIN LATERAL (
              SELECT e.reason, e.detail
                FROM dispatch_events e
               WHERE e.dispatch_id = d.dispatch_id AND e.event_type = 'plan_exception'
                 AND NOT EXISTS (
                     SELECT 1 FROM dispatch_events s
                      WHERE s.dispatch_id = e.dispatch_id AND s.event_type = 'status_changed' AND s.dispatch_event_id > e.dispatch_event_id
                 )
               ORDER BY e.created_at DESC, e.dispatch_event_id DESC
               LIMIT 1
          ) pe ON TRUE
         WHERE s.name = ANY($5::text[])
    )
    SELECT c.dispatch_id, c.status, c.priority, c.window_start, c.route_batch_id, c.batch_status, c.batch_version,
           c.batch_shift_date, c.zone_id, c.zone_name, c.warehouse_id, c.warehouse_name, c.operating_date, c.shift,
           c.vehicle_id, c.vehicle_plate, c.driver_id, c.driver_name, c.plan_reason, c.plan_detail
      FROM candidate c
     WHERE (c.operating_date = to_char($1::date, 'YYYY-MM-DD')
            OR (c.operating_date IS NULL AND c.route_batch_id IS NULL AND c.created_day <= $1::date))
       AND ($2::int IS NULL OR c.zone_id = $2::int)
       AND ($3::int IS NULL OR c.warehouse_id = $3::int)
       AND ($4::text IS NULL OR c.shift = $4::text)
     ORDER BY c.priority = 'urgent' DESC, c.window_start ASC NULLS LAST, c.dispatch_id ASC`;

export const BATCH_VEHICLES_SQL = `
    SELECT rb.route_batch_id, v.vehicle_id, v.capacity_kg, v.capacity_m3,
           v.max_package_length_cm, v.max_package_width_cm, v.max_package_height_cm
      FROM route_batches rb
      LEFT JOIN vehicles v ON v.vehicle_id = rb.vehicle_id AND v.deleted_at IS NULL
     WHERE rb.route_batch_id = ANY($1::int[])`;

export const BATCH_LOADS_SQL = `
    SELECT d.route_batch_id, d.dispatch_id, d.estimated_weight_kg, d.estimated_volume_m3,
           p.dispatch_package_id AS package_id, p.length_cm, p.width_cm, p.height_cm, p.gross_weight_kg
      FROM dispatches d
      LEFT JOIN dispatch_packages p ON p.dispatch_id = d.dispatch_id
     WHERE d.route_batch_id = ANY($1::int[])
     ORDER BY d.route_batch_id, d.dispatch_id, p.dispatch_package_id`;

/** The generator writes `promise_deadline_exceeded` in the event; the pipeline names it `deadline_exceeded`. */
function normalizePlanReason(reason: string | null): string | null {
    return reason === 'promise_deadline_exceeded' ? 'deadline_exceeded' : reason;
}

function numberOrNull(value: string | number | null): number | null {
    return value === null ? null : Number(value);
}

function ref(id: number | null, name: string | null): { id: number; name: string } | null {
    return id === null ? null : { id, name: name ?? '' };
}

@Injectable()
export class PipelineRepository {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    /** Every dispatch of the day that is in the pipeline, most urgent first. The stage is judged afterwards by the domain rules. */
    async findCandidates(filters: PipelineFilters): Promise<PipelineCandidate[]> {
        const rows: CandidateRow[] = await this.dataSource.query(PIPELINE_CANDIDATES_SQL, [
            filters.date,
            filters.zoneId ?? null,
            filters.warehouseId ?? null,
            filters.shift ?? null,
            [...PIPELINE_STATUSES],
        ]);
        return rows.map((row) => ({
            dispatchId: row.dispatch_id,
            status: row.status,
            priority: row.priority,
            windowStart: row.window_start,
            routeBatchId: row.route_batch_id,
            batchStatus: row.batch_status,
            batchVersion: row.batch_version,
            batchShiftDate: row.batch_shift_date,
            zone: ref(row.zone_id, row.zone_name),
            warehouse: ref(row.warehouse_id, row.warehouse_name),
            operatingDate: row.operating_date,
            shift: row.shift,
            vehicle: ref(row.vehicle_id, row.vehicle_plate),
            driver: ref(row.driver_id, row.driver_name),
            planExceptionReason: normalizePlanReason(row.plan_reason),
            planExceptionDetail: row.plan_detail,
        }));
    }

    /**
     * The load of each batch against its vehicle, kg and m³ separately. Two queries for all the batches
     * (not one per batch), measured with the same rule as the vehicle assignment (`calculateRouteCapacity`),
     * and without locking any row: this is a read-only view.
     */
    async loadBatches(batchIds: number[]): Promise<Map<number, BatchLoad>> {
        const loads = new Map<number, BatchLoad>();
        if (batchIds.length === 0) return loads;

        const [vehicles, loadRows]: [BatchVehicleRow[], BatchLoadRow[]] = await Promise.all([
            this.dataSource.query(BATCH_VEHICLES_SQL, [batchIds]),
            this.dataSource.query(BATCH_LOADS_SQL, [batchIds]),
        ]);

        const dispatchesByBatch = new Map<number, Map<number, RouteCapacityDispatch>>();
        for (const row of loadRows) {
            let dispatches = dispatchesByBatch.get(row.route_batch_id);
            if (!dispatches) dispatchesByBatch.set(row.route_batch_id, (dispatches = new Map()));
            let dispatch = dispatches.get(row.dispatch_id);
            if (!dispatch) {
                dispatch = {
                    dispatchId: row.dispatch_id,
                    estimatedWeightKg: numberOrNull(row.estimated_weight_kg),
                    estimatedVolumeM3: numberOrNull(row.estimated_volume_m3),
                    packages: [],
                };
                dispatches.set(row.dispatch_id, dispatch);
            }
            if (row.package_id !== null) {
                dispatch.packages.push({
                    dispatchId: row.dispatch_id,
                    packageId: row.package_id,
                    lengthCm: Number(row.length_cm),
                    widthCm: Number(row.width_cm),
                    heightCm: Number(row.height_cm),
                    grossWeightKg: Number(row.gross_weight_kg),
                });
            }
        }

        for (const batch of vehicles) {
            const dispatches = [...(dispatchesByBatch.get(batch.route_batch_id)?.values() ?? [])];
            const hasVehicle = batch.vehicle_id !== null && batch.capacity_kg !== null && batch.capacity_m3 !== null;
            const vehicle: VehicleCapacity | null = hasVehicle
                ? {
                      capacityKg: Number(batch.capacity_kg),
                      capacityM3: Number(batch.capacity_m3),
                      maxPackageLengthCm: numberOrNull(batch.max_package_length_cm),
                      maxPackageWidthCm: numberOrNull(batch.max_package_width_cm),
                      maxPackageHeightCm: numberOrNull(batch.max_package_height_cm),
                  }
                : null;
            loads.set(batch.route_batch_id, {
                capacity: vehicle === null ? null : toPipelineCapacity(calculateRouteCapacity(dispatches, vehicle)),
                dispatchCount: dispatches.length,
            });
        }
        return loads;
    }
}
