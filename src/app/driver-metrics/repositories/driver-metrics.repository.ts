import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OPERATING_TIME_ZONE } from '../../../modules/dispatch/dispatches/utils/operating-date.util.js';
import { DispatchStatusEnum } from '../../../shared/enums/dispatch-status.enum.js';
import type { MetricsDateRange } from '../domain/metrics-period.js';

export interface DriverMetricsRow {
    deliveredCount: number;
    onTimeCount: number;
    assignedCount: number;
    ratingsCount: number;
    /** Average score, or null when there are no ratings. */
    ratingAverage: number | null;
}

// Whole Bolivia days: `from` starts at 00:00 of its day and `to` includes all of its day (same rule as the history).
const FROM_TS = `($2::date)::timestamp AT TIME ZONE '${OPERATING_TIME_ZONE}'`;
const TO_TS = `(($3::date + 1)::timestamp AT TIME ZONE '${OPERATING_TIME_ZONE}')`;

// Deliveries: the driver of a dispatch is the driver of its route. `closed_at` is the time of the event
// (the idempotent sync writes the device time), so a delivery synced late still counts in the day it happened.
// A dispatch without a window cannot be on time. `dispatch_ratings.dispatch_id` is unique, so the join never repeats a delivery.
const DELIVERIES_SQL = `
    SELECT COUNT(*)::int AS delivered_count,
           COUNT(*) FILTER (
               WHERE d.scheduled_window_start IS NOT NULL AND d.scheduled_window_end IS NOT NULL
                 AND d.closed_at BETWEEN d.scheduled_window_start AND d.scheduled_window_end
           )::int AS on_time_count,
           COUNT(r.dispatch_rating_id)::int AS ratings_count,
           AVG(r.score)::float8 AS rating_average
      FROM dispatches d
      JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
      JOIN route_batches rb ON rb.route_batch_id = d.route_batch_id
      LEFT JOIN dispatch_ratings r ON r.dispatch_id = d.dispatch_id
     WHERE rb.driver_id = $1
       AND s.name = '${DispatchStatusEnum.DELIVERED}'
       AND d.closed_at IS NOT NULL
       AND d.closed_at >= ${FROM_TS}
       AND d.closed_at < ${TO_TS}`;

// Assigned: every dispatch on a route of the driver whose day falls in the period, whatever its outcome.
const ASSIGNED_SQL = `
    SELECT COUNT(*)::int AS assigned_count
      FROM dispatches d
      JOIN route_batches rb ON rb.route_batch_id = d.route_batch_id
     WHERE rb.driver_id = $1
       AND rb.status <> 'cancelled'
       AND rb.shift_date BETWEEN $2::date AND $3::date`;

interface DeliveriesRow { delivered_count: number; on_time_count: number; ratings_count: number; rating_average: number | null }
interface AssignedRow { assigned_count: number }

/** Aggregations of RF-U09 computed by PostgreSQL: the app only receives the totals, never the dispatches. */
@Injectable()
export class DriverMetricsRepository {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    /** The driver of the route a dispatch belongs to; null when it has no route or the route has no driver. */
    async findDriverIdOfDispatch(dispatchId: number): Promise<number | null> {
        const rows: { driver_id: number | null }[] = await this.dataSource.query(
            `SELECT rb.driver_id
               FROM dispatches d
               JOIN route_batches rb ON rb.route_batch_id = d.route_batch_id
              WHERE d.dispatch_id = $1`,
            [dispatchId],
        );
        return rows[0]?.driver_id ?? null;
    }

    async aggregate(driverId: number, range: MetricsDateRange): Promise<DriverMetricsRow> {
        const args = [driverId, range.from, range.to];
        const [[deliveries], [assigned]] = await Promise.all([
            this.dataSource.query(DELIVERIES_SQL, args) as Promise<DeliveriesRow[]>,
            this.dataSource.query(ASSIGNED_SQL, args) as Promise<AssignedRow[]>,
        ]);
        return {
            deliveredCount: deliveries.delivered_count,
            onTimeCount: deliveries.on_time_count,
            assignedCount: assigned.assigned_count,
            ratingsCount: deliveries.ratings_count,
            ratingAverage: deliveries.rating_average,
        };
    }
}
