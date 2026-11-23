import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { CoverageItem } from '../domain/coverage.js';
import type { BaselineStop } from '../domain/route-completion.js';

export interface SnapshotFilters {
    zoneId?: number;
    warehouseId?: number;
    shift?: 'morning' | 'afternoon';
}

export interface CutoffRow {
    id: number;
    shiftDate: string;
    cutoffAt: Date;
    operatingTimezone: string;
    triggerType: 'scheduled' | 'manual';
    occurrence: string | null;
    eligible: number;
    excluded: number;
}

export interface UniverseRow extends CoverageItem {
    exclusionDetail: string | null;
    routeBatchId: number;
}

export interface StartedManifestRow {
    manifestId: number;
    routeBatchId: number;
    manifestVersion: number;
    routeVersion: number;
    startedAt: Date;
    vehicle: { id: number; name: string } | null;
    driver: { id: number; name: string } | null;
    zone: { id: number; name: string } | null;
    warehouse: { id: number; name: string } | null;
}

export interface BaselineStopRow extends BaselineStop {
    routeBatchId: number;
}

/** The shift of a promise window, with the same rule as the pipeline (ST-302.1): before 12:00 `morning`, from 12:00 `afternoon`, America/La_Paz. */
const shiftOf = (column: string): string =>
    `CASE WHEN ${column} IS NULL THEN NULL
          WHEN EXTRACT(HOUR FROM ${column} AT TIME ZONE 'America/La_Paz') < 12 THEN 'morning'
          ELSE 'afternoon' END`;

const CUTOFF_SELECT = `
    SELECT c.planning_cutoff_id AS id, to_char(c.shift_date, 'YYYY-MM-DD') AS "shiftDate", c.cutoff_at AS "cutoffAt",
           c.operating_timezone AS "operatingTimezone", c.trigger_type AS "triggerType", c.occurrence,
           COUNT(i.planning_cutoff_dispatch_id) FILTER (WHERE i.universe_status = 'eligible')::int AS eligible,
           COUNT(i.planning_cutoff_dispatch_id) FILTER (WHERE i.universe_status = 'excluded')::int AS excluded
      FROM planning_cutoffs c
      LEFT JOIN planning_cutoff_dispatches i ON i.planning_cutoff_id = c.planning_cutoff_id`;

const ref = (id: number | null, name: string | null): { id: number; name: string } | null => (id === null || name === null ? null : { id, name });

/** Read side of the planning snapshots (ST-302.2, ES-302). Nothing here writes, and nothing reads today's statuses to rebuild a past universe. */
@Injectable()
export class PlanningSnapshotsRepository {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async findCutoffsOfDay(date: string): Promise<CutoffRow[]> {
        return await this.dataSource.query(
            `${CUTOFF_SELECT} WHERE c.shift_date = $1::date GROUP BY c.planning_cutoff_id ORDER BY c.cutoff_at, c.planning_cutoff_id`,
            [date],
        );
    }

    async findCutoff(id: number): Promise<CutoffRow | null> {
        const [row]: CutoffRow[] = await this.dataSource.query(`${CUTOFF_SELECT} WHERE c.planning_cutoff_id = $1 GROUP BY c.planning_cutoff_id`, [id]);
        return row ?? null;
    }

    /**
     * The universe of one cutoff after the filters, each dispatch with whether it was confirmed. Confirmed means it
     * appears in a `confirmed` manifest written after the cutoff, of a batch of the same operating day.
     */
    async findUniverse(cutoffId: number, filters: SnapshotFilters): Promise<UniverseRow[]> {
        return await this.dataSource.query(
            `SELECT i.dispatch_id AS "dispatchId", i.universe_status AS "universeStatus", i.exclusion_code AS "exclusionCode",
                    i.exclusion_detail AS "exclusionDetail", i.route_batch_id AS "routeBatchId",
                    EXISTS (
                        SELECT 1
                          FROM route_manifest_stops s
                          JOIN route_manifests m ON m.route_manifest_id = s.route_manifest_id
                          JOIN route_batches b ON b.route_batch_id = m.route_batch_id
                         WHERE s.dispatch_id = i.dispatch_id AND m.kind = 'confirmed'
                           AND m.created_at >= c.cutoff_at AND b.shift_date = c.shift_date
                    ) AS confirmed
               FROM planning_cutoff_dispatches i
               JOIN planning_cutoffs c ON c.planning_cutoff_id = i.planning_cutoff_id
              WHERE i.planning_cutoff_id = $1
                AND ($2::int IS NULL OR i.delivery_zone_id = $2)
                AND ($3::int IS NULL OR i.origin_warehouse_id = $3)
                AND ($4::text IS NULL OR (${shiftOf('i.scheduled_window_start')}) = $4)
              ORDER BY i.dispatch_id`,
            [cutoffId, filters.zoneId ?? null, filters.warehouseId ?? null, filters.shift ?? null],
        );
    }

    /** Dispatches confirmed after the cutoff, on the same day, that the cutoff did not have in its universe. */
    async countConfirmedOutsideUniverse(cutoffId: number): Promise<number> {
        const [row]: { total: number }[] = await this.dataSource.query(
            `SELECT COUNT(DISTINCT s.dispatch_id)::int AS total
               FROM planning_cutoffs c
               JOIN route_batches b ON b.shift_date = c.shift_date
               JOIN route_manifests m ON m.route_batch_id = b.route_batch_id AND m.kind = 'confirmed' AND m.created_at >= c.cutoff_at
               JOIN route_manifest_stops s ON s.route_manifest_id = m.route_manifest_id
              WHERE c.planning_cutoff_id = $1
                AND NOT EXISTS (SELECT 1 FROM planning_cutoff_dispatches i WHERE i.planning_cutoff_id = c.planning_cutoff_id AND i.dispatch_id = s.dispatch_id)`,
            [cutoffId],
        );
        return row?.total ?? 0;
    }

    async findStartedManifests(date: string, filters: SnapshotFilters): Promise<StartedManifestRow[]> {
        const rows: Array<{
            manifestId: number; routeBatchId: number; manifestVersion: number; routeVersion: number; startedAt: Date;
            vehicleId: number | null; vehiclePlate: string | null; driverId: number | null; driverName: string | null;
            zoneId: number | null; zoneName: string | null; warehouseId: number | null; warehouseName: string | null;
        }> = await this.dataSource.query(
            `SELECT m.route_manifest_id AS "manifestId", m.route_batch_id AS "routeBatchId", m.manifest_version AS "manifestVersion",
                    m.route_version AS "routeVersion", m.created_at AS "startedAt",
                    v.vehicle_id AS "vehicleId", v.plate AS "vehiclePlate", u.user_id AS "driverId", u.full_name AS "driverName",
                    z.delivery_zone_id AS "zoneId", z.name AS "zoneName", w.warehouse_id AS "warehouseId", w.name AS "warehouseName"
               FROM route_manifests m
               JOIN route_batches b ON b.route_batch_id = m.route_batch_id
               LEFT JOIN vehicles v ON v.vehicle_id = m.vehicle_id
               LEFT JOIN users u ON u.user_id = m.driver_id
               LEFT JOIN delivery_zones z ON z.delivery_zone_id = b.delivery_zone_id
               LEFT JOIN warehouses w ON w.warehouse_id = b.origin_warehouse_id
              WHERE m.kind = 'started' AND b.shift_date = $1::date
                AND ($2::int IS NULL OR b.delivery_zone_id = $2)
                AND ($3::int IS NULL OR b.origin_warehouse_id = $3)
              ORDER BY m.route_batch_id`,
            [date, filters.zoneId ?? null, filters.warehouseId ?? null],
        );
        return rows.map((row) => ({
            manifestId: row.manifestId,
            routeBatchId: row.routeBatchId,
            manifestVersion: row.manifestVersion,
            routeVersion: row.routeVersion,
            startedAt: row.startedAt,
            vehicle: ref(row.vehicleId, row.vehiclePlate),
            driver: ref(row.driverId, row.driverName),
            zone: ref(row.zoneId, row.zoneName),
            warehouse: ref(row.warehouseId, row.warehouseName),
        }));
    }

    /**
     * The baseline of each route: the stops of its `started` manifest plus those of its first `confirmed` one that did not
     * leave, each with the status it has now. A stop that was reassigned to another route is in the baseline of the route
     * it left and only there.
     */
    async findBaselineStops(routeBatchIds: number[], shift: SnapshotFilters['shift']): Promise<BaselineStopRow[]> {
        if (routeBatchIds.length === 0) return [];
        const rows: Array<{
            routeBatchId: number; dispatchId: number; sequenceOrder: number | null; startedState: 'departing' | 'excluded' | null;
            dispatchType: string; currentStatus: string;
        }> = await this.dataSource.query(
            `WITH started AS (
                    SELECT m.route_batch_id, s.dispatch_id, s.sequence_order, s.stop_state
                      FROM route_manifest_stops s JOIN route_manifests m ON m.route_manifest_id = s.route_manifest_id
                     WHERE m.kind = 'started' AND m.route_batch_id = ANY($1::int[])
                 ), first_confirmed AS (
                    SELECT DISTINCT ON (m.route_batch_id) m.route_manifest_id, m.route_batch_id
                      FROM route_manifests m
                     WHERE m.kind = 'confirmed' AND m.route_batch_id = ANY($1::int[])
                     ORDER BY m.route_batch_id, m.manifest_version
                 ), confirmed AS (
                    SELECT fc.route_batch_id, s.dispatch_id, s.sequence_order
                      FROM route_manifest_stops s JOIN first_confirmed fc ON fc.route_manifest_id = s.route_manifest_id
                 ), baseline AS (
                    SELECT COALESCE(st.route_batch_id, cf.route_batch_id) AS route_batch_id,
                           COALESCE(st.dispatch_id, cf.dispatch_id) AS dispatch_id,
                           COALESCE(st.sequence_order, cf.sequence_order) AS sequence_order,
                           st.stop_state AS started_state
                      FROM started st
                      FULL JOIN confirmed cf ON cf.route_batch_id = st.route_batch_id AND cf.dispatch_id = st.dispatch_id
                 )
             SELECT bl.route_batch_id AS "routeBatchId", bl.dispatch_id AS "dispatchId", bl.sequence_order AS "sequenceOrder",
                    bl.started_state AS "startedState", t.name AS "dispatchType", ds.name AS "currentStatus"
               FROM baseline bl
               JOIN dispatches d ON d.dispatch_id = bl.dispatch_id
               JOIN dispatch_types t ON t.dispatch_type_id = d.dispatch_type_id
               JOIN dispatch_statuses ds ON ds.dispatch_status_id = d.dispatch_status_id
              WHERE ($2::text IS NULL OR (${shiftOf('d.scheduled_window_start')}) = $2)
              ORDER BY bl.route_batch_id, bl.sequence_order NULLS LAST, bl.dispatch_id`,
            [routeBatchIds, shift ?? null],
        );
        return rows;
    }

    /** Routes of the day that are running or closed but have no `started` manifest: history from before ST-302.2, unknown and never rebuilt. */
    async findRoutesWithoutBaseline(date: string, filters: SnapshotFilters): Promise<number[]> {
        const rows: { id: number }[] = await this.dataSource.query(
            `SELECT b.route_batch_id AS id
               FROM route_batches b
              WHERE b.shift_date = $1::date AND b.status IN ('in_execution', 'closed')
                AND NOT EXISTS (SELECT 1 FROM route_manifests m WHERE m.route_batch_id = b.route_batch_id AND m.kind = 'started')
                AND ($2::int IS NULL OR b.delivery_zone_id = $2)
                AND ($3::int IS NULL OR b.origin_warehouse_id = $3)
              ORDER BY b.route_batch_id`,
            [date, filters.zoneId ?? null, filters.warehouseId ?? null],
        );
        return rows.map((row) => row.id);
    }
}
