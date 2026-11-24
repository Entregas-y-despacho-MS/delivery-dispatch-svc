import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { FROM_TS, TO_TS } from '../../delivery-promise/repositories/delivery-promise.sql.js';
import type { ComplianceQuery, PickupAppointmentRow } from '../domain/compliance-report.js';

/**
 * Supplier pickups whose appointment falls in the range (ST-305.1). Parameters: `$1` from, `$2` to (Bolivia days), `$3` supplier
 * id, `$4` destination warehouse id, `$5` zone id, `$6` current status (the last four may be NULL = no filter).
 *
 * - The anchor of the range is the end of the window in force; with no valid window it is the closing time, else the creation
 *   time, so a pickup without appointment does not disappear.
 * - The supplier is not a column: it is read from the last dispatch event that carries `metadata.supplier.supplierId`
 *   (the intake writes it in `created` and `supplier_pickup_updated`; no event type is filtered).
 * - The original appointment is the window the FIRST reschedule replaced (`dispatch_reschedules` is append-only).
 * - Nothing is classified here: the rows go to `buildComplianceReport`.
 */
export const SUPPLIER_PICKUP_ROWS_SQL = `
    SELECT d.dispatch_id, s.name AS status, d.source_order_ref,
           sup.supplier_id, sup.supplier_name,
           d.destination_warehouse_id,
           d.scheduled_window_start AS window_start, d.scheduled_window_end AS window_end,
           r.previous_window_start AS original_window_start, r.previous_window_end AS original_window_end, r.created_at AS first_reschedule_at,
           d.custody_received_at, d.arrived_at_warehouse_at
      FROM dispatches d
      JOIN dispatch_types t ON t.dispatch_type_id = d.dispatch_type_id AND t.name = 'supplier_pickup'
      JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
      LEFT JOIN LATERAL (
            SELECT e.metadata->'supplier'->>'supplierId' AS supplier_id, e.metadata->'supplier'->>'name' AS supplier_name
              FROM dispatch_events e
             WHERE e.dispatch_id = d.dispatch_id AND e.metadata->'supplier'->>'supplierId' IS NOT NULL
             ORDER BY e.created_at DESC, e.dispatch_event_id DESC
             LIMIT 1
      ) sup ON TRUE
      LEFT JOIN LATERAL (
            SELECT x.previous_window_start, x.previous_window_end, x.created_at
              FROM dispatch_reschedules x
             WHERE x.dispatch_id = d.dispatch_id AND x.previous_window_end IS NOT NULL
             ORDER BY x.created_at ASC, x.dispatch_reschedule_id ASC
             LIMIT 1
      ) r ON TRUE
     WHERE (CASE WHEN d.scheduled_window_start IS NOT NULL AND d.scheduled_window_end IS NOT NULL AND d.scheduled_window_end >= d.scheduled_window_start
                 THEN d.scheduled_window_end ELSE COALESCE(d.closed_at, d.created_at) END) >= ${FROM_TS}
       AND (CASE WHEN d.scheduled_window_start IS NOT NULL AND d.scheduled_window_end IS NOT NULL AND d.scheduled_window_end >= d.scheduled_window_start
                 THEN d.scheduled_window_end ELSE COALESCE(d.closed_at, d.created_at) END) < ${TO_TS}
       AND ($3::text IS NULL OR sup.supplier_id = $3::text)
       AND ($4::int IS NULL OR d.destination_warehouse_id = $4::int)
       AND ($5::int IS NULL OR d.delivery_zone_id = $5::int)
       AND ($6::text IS NULL OR s.name = $6::text)`;

interface RawRow {
    dispatch_id: number;
    status: string;
    source_order_ref: string;
    supplier_id: string | null;
    supplier_name: string | null;
    destination_warehouse_id: number | null;
    window_start: Date | null;
    window_end: Date | null;
    original_window_start: Date | null;
    original_window_end: Date | null;
    first_reschedule_at: Date | null;
    custody_received_at: Date | null;
    arrived_at_warehouse_at: Date | null;
}

@Injectable()
export class SupplierPickupComplianceRepository {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    /** `query.from` and `query.to` are Bolivia days (`YYYY-MM-DD`), both included; the caller has already validated the range. */
    async findAppointments(query: ComplianceQuery): Promise<PickupAppointmentRow[]> {
        const rows: RawRow[] = await this.dataSource.query(SUPPLIER_PICKUP_ROWS_SQL, [
            query.from, query.to, query.supplierId ?? null, query.warehouseId ?? null, query.zoneId ?? null, query.status ?? null,
        ]);
        return rows.map((row) => ({
            dispatchId: row.dispatch_id,
            status: row.status,
            purchaseOrderRef: row.source_order_ref,
            supplierId: row.supplier_id,
            supplierName: row.supplier_name,
            destinationWarehouseId: row.destination_warehouse_id,
            windowStart: row.window_start,
            windowEnd: row.window_end,
            originalWindowStart: row.original_window_start,
            originalWindowEnd: row.original_window_end,
            firstRescheduleAt: row.first_reschedule_at,
            custodyReceivedAt: row.custody_received_at,
            arrivedAtWarehouseAt: row.arrived_at_warehouse_at,
        }));
    }
}
