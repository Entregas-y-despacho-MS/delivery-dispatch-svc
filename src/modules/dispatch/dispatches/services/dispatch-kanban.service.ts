import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { FindKanbanParamsDto } from '../dto/find-kanban-params.dto.js';
import { DispatchKanbanItemDto, DispatchKanbanResponseDto } from '../dto/dispatch-kanban.dto.js';
import { DispatchKanbanFiltersResponseDto } from '../dto/dispatch-kanban-filters.dto.js';
import { todayInOperatingTimeZone } from '../utils/operating-date.util.js';

const COLUMNS = [
    { key: 'pending', statuses: ['pending'], label: 'Pendiente' },
    { key: 'in_planning', statuses: ['in_planning'], label: 'En planificación' },
    { key: 'scheduled', statuses: ['scheduled'], label: 'Programado' },
    { key: 'assigned', statuses: ['assigned'], label: 'Asignado' },
    { key: 'out_for_delivery', statuses: ['out_for_delivery'], label: 'En ruta' },
    { key: 'in_transit', statuses: ['in_transit'], label: 'En camino' },
    { key: 'delivered', statuses: ['delivered'], label: 'Entregado' },
    { key: 'incident', statuses: ['incident', 'not_delivered'], label: 'Incidencia' },
    { key: 'rescheduled', statuses: ['rescheduled'], label: 'Reprogramado' },
    { key: 'pickup_scheduled', statuses: ['pickup_scheduled'], label: 'Recojo programado' },
    { key: 'picked_up_in_transit', statuses: ['picked_up_in_transit'], label: 'Recojo en camino' },
    { key: 'returned_to_warehouse', statuses: ['returned_to_warehouse'], label: 'Devuelto a almacén' },
    { key: 'returned', statuses: ['returned'], label: 'Devuelto' },
];

interface KanbanRow {
    id: number; source_order_ref: string; tracking_code: string | null; status: string;
    dispatch_type_id: number; dispatch_type_name: string; zone_id: number | null; zone_name: string | null;
    driver_id: number | null; driver_name: string | null; vehicle_id: number | null; vehicle_plate: string | null;
    window_start: Date | null; window_end: Date | null; priority: string; volume_m3: string;
    attempt_count: string; attempt_limit: string; route_batch_id: number | null; route_batch_status: string | null;
    reserved_by: number | null; reserved_by_name: string | null; reservation_expires_at: Date | null;
}

@Injectable()
export class DispatchKanbanService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async findFilters(): Promise<DispatchKanbanFiltersResponseDto> {
        const [drivers, dispatchTypes] = await Promise.all([
            this.dataSource.query(
                `SELECT u.user_id AS id, u.full_name AS "fullName"
                   FROM users u
                   JOIN roles r ON r.role_id = u.role_id
                  WHERE r.name = 'driver' AND u.active = TRUE AND u.deleted_at IS NULL
                  ORDER BY u.full_name ASC, u.user_id ASC`,
            ),
            this.dataSource.query(
                `SELECT dispatch_type_id AS id, name
                   FROM dispatch_types
                  ORDER BY name ASC, dispatch_type_id ASC`,
            ),
        ]);

        return { drivers, dispatchTypes };
    }

    async findAll(params: FindKanbanParamsDto, viewerId: number): Promise<DispatchKanbanResponseDto> {
        const date = params.date ?? todayInOperatingTimeZone();
        const values: unknown[] = [date];
        const where = [
            `COALESCE(rb.shift_date, (d.scheduled_window_start AT TIME ZONE 'America/La_Paz')::date, (d.created_at AT TIME ZONE 'America/La_Paz')::date) = $1::date`,
            `s.name <> 'cancelled'`,
        ];
        const addFilter = (column: string, value: number | undefined) => {
            if (value !== undefined) { values.push(value); where.push(`${column} = $${values.length}`); }
        };
        addFilter('COALESCE(d.delivery_zone_id, rb.delivery_zone_id)', params.delivery_zone_id);
        addFilter('COALESCE(rb.driver_id, rb.proposed_driver_id)', params.driver_id);
        addFilter('d.dispatch_type_id', params.dispatch_type_id);

        const rows: KanbanRow[] = await this.dataSource.query(
            `SELECT d.dispatch_id AS id, d.source_order_ref, d.tracking_code, s.name AS status,
                    dt.dispatch_type_id, dt.name AS dispatch_type_name,
                    COALESCE(d.delivery_zone_id, rb.delivery_zone_id) AS zone_id, z.name AS zone_name,
                    driver.user_id AS driver_id, driver.full_name AS driver_name,
                    v.vehicle_id AS vehicle_id, v.plate AS vehicle_plate,
                    d.scheduled_window_start AS window_start, d.scheduled_window_end AS window_end,
                    d.priority,
                    COALESCE(pkg.volume_m3, 0)::text AS volume_m3,
                    COALESCE(retry.count, 0)::text AS attempt_count,
                    COALESCE(setting.setting_value::int, 3)::text AS attempt_limit,
                    rb.route_batch_id AS route_batch_id, rb.status AS route_batch_status,
                    reservation.reserved_by, reserver.full_name AS reserved_by_name,
                    reservation.expires_at AS reservation_expires_at
               FROM dispatches d
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
               JOIN dispatch_types dt ON dt.dispatch_type_id = d.dispatch_type_id
               LEFT JOIN route_batches rb ON rb.route_batch_id = d.route_batch_id
               LEFT JOIN delivery_zones z ON z.delivery_zone_id = COALESCE(d.delivery_zone_id, rb.delivery_zone_id)
               LEFT JOIN users driver ON driver.user_id = COALESCE(rb.driver_id, rb.proposed_driver_id)
               LEFT JOIN vehicles v ON v.vehicle_id = rb.vehicle_id
               LEFT JOIN LATERAL (
                   SELECT SUM(p.length_cm * p.width_cm * p.height_cm) / 1000000 AS volume_m3
                     FROM dispatch_packages p WHERE p.dispatch_id = d.dispatch_id
               ) pkg ON TRUE
               LEFT JOIN LATERAL (
                   SELECT COUNT(*) AS count
                     FROM dispatch_incidents i
                     JOIN incident_reasons ir ON ir.incident_reason_id = i.incident_reason_id
                    WHERE i.dispatch_id = d.dispatch_id AND ir.counts_as_attempt = TRUE
               ) retry ON TRUE
               LEFT JOIN settings setting ON setting.setting_key = 'max_delivery_attempts'
               LEFT JOIN LATERAL (
                   SELECT r.reserved_by, r.expires_at
                     FROM dispatch_reservations r
                    WHERE r.dispatch_id = d.dispatch_id AND r.expires_at > NOW()
                    ORDER BY r.expires_at DESC LIMIT 1
               ) reservation ON TRUE
               LEFT JOIN users reserver ON reserver.user_id = reservation.reserved_by
              WHERE ${where.join(' AND ')}
              ORDER BY d.priority = 'urgent' DESC, d.scheduled_window_start ASC NULLS LAST, d.dispatch_id ASC`,
            values,
        );

        const dispatches = rows.map((row): DispatchKanbanItemDto => {
            const reservedByMe = row.reserved_by === viewerId;
            const reservation = row.reserved_by === null ? null : {
                reservedById: row.reserved_by,
                reservedByName: row.reserved_by_name ?? '',
                expiresAt: row.reservation_expires_at!,
                reservedByMe,
            };
            const proposed = row.status === 'in_planning' && reservation === null;
            return {
                id: row.id,
                sourceOrderRef: row.source_order_ref,
                trackingCode: row.tracking_code,
                status: row.status,
                dispatchType: { id: row.dispatch_type_id, name: row.dispatch_type_name },
                zone: row.zone_id === null ? null : { id: row.zone_id, name: row.zone_name! },
                driver: row.driver_id === null ? null : { id: row.driver_id, fullName: row.driver_name! },
                vehicle: row.vehicle_id === null ? null : { id: row.vehicle_id, plate: row.vehicle_plate! },
                windowStart: row.window_start,
                windowEnd: row.window_end,
                priority: row.priority,
                volumeM3: Number(row.volume_m3),
                attemptCount: Number(row.attempt_count),
                attemptLimit: Number(row.attempt_limit),
                routeBatch: row.route_batch_id === null ? null : { id: row.route_batch_id, status: row.route_batch_status! },
                inbox: proposed ? 'proposed' : reservation ? 'reserved' : null,
                reservation,
            };
        });

        return {
            date,
            columns: COLUMNS.map(({ key, statuses, label }) => {
                const columnDispatches = dispatches.filter((dispatch) => statuses.includes(dispatch.status));
                return {
                    key, statuses, label,
                    ordersCount: columnDispatches.length,
                    volumeM3: columnDispatches.reduce((sum, dispatch) => sum + dispatch.volumeM3, 0),
                    dispatches: columnDispatches,
                };
            }),
        };
    }
}
