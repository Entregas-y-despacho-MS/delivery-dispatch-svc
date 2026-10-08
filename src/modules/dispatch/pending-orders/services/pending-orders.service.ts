import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BUSINESS_TIME_ZONE, INBOX_ELIGIBILITY_SQL } from '../../dispatches/utils/inbox-eligibility.js';
import { FindPendingOrdersParamsDto, PendingOrderSortBy } from '../dto/find-pending-orders-params.dto.js';
import { FindPendingOrdersResponseDto, PendingOrderDto } from '../dto/pending-order.dto.js';
import { escapeLike } from '../../../../shared/utils/like.util.js';

const LOCAL_START = `(d.scheduled_window_start AT TIME ZONE '${BUSINESS_TIME_ZONE}')`;
const SHIFT_SQL = `CASE WHEN d.scheduled_window_start IS NULL THEN NULL
                        WHEN EXTRACT(HOUR FROM ${LOCAL_START}) < 12 THEN 'morning' ELSE 'afternoon' END`;
const SLA_DUE_SQL = `(d.created_at + sl.target_time_min * INTERVAL '1 minute')`;
const URGENT_FIRST_SQL = `CASE WHEN d.priority = 'urgent' THEN 0 ELSE 1 END`;

// Whitelist: the value that reaches ORDER BY is always one of these, never user text.
const SORT_SQL: Record<PendingOrderSortBy, string> = {
    [PendingOrderSortBy.ORDER_NUMBER]: 'd.source_order_ref',
    [PendingOrderSortBy.RECIPIENT]:    'LOWER(d.contact_name)',
    [PendingOrderSortBy.ZONE]:         'LOWER(z.name)',
    [PendingOrderSortBy.WINDOW]:       'd.scheduled_window_start',
    [PendingOrderSortBy.WEIGHT]:       'pk.weight_kg',
    [PendingOrderSortBy.PRIORITY]:     URGENT_FIRST_SQL,
};

// A reservation counts only while it is in the future: an abandoned one simply stops showing up.
const FROM_SQL = `
    FROM dispatches d
    JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
    LEFT JOIN delivery_zones z ON z.delivery_zone_id = d.delivery_zone_id
    LEFT JOIN service_levels sl ON sl.service_level_id = d.service_level_id
    LEFT JOIN dispatch_reservations r ON r.dispatch_id = d.dispatch_id AND r.expires_at > NOW()
    LEFT JOIN users u ON u.user_id = r.reserved_by
    LEFT JOIN LATERAL (
        SELECT COUNT(*)                                                       AS packages_count,
               COALESCE(SUM(p.gross_weight_kg), 0)                            AS weight_kg,
               COALESCE(SUM(p.length_cm * p.width_cm * p.height_cm) / 1000000, 0) AS volume_m3
          FROM dispatch_packages p WHERE p.dispatch_id = d.dispatch_id
    ) pk ON TRUE`;

interface Row {
    id: number; order_number: string; tracking_code: string | null; recipient: string | null; recipient_phone: string | null;
    address: string; zone_id: number | null; zone_name: string | null; shift: 'morning' | 'afternoon' | null;
    window_start: Date | null; window_end: Date | null; priority: string; status: string; sla_due_at: Date | null;
    packages_count: string; weight_kg: string; volume_m3: string;
    reserved_by: number | null; reserved_by_name: string | null; reservation_expires_at: Date | null;
}

/** ST-48.2 / RF-A40 — the coordinator's inbox of orders waiting to be planned. */
@Injectable()
export class PendingOrdersService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async findAll(params: FindPendingOrdersParamsDto, userId: number): Promise<FindPendingOrdersResponseDto> {
        const { page, limit } = params;
        const args: unknown[] = [];
        const bind = (value: unknown): string => { args.push(value); return `$${args.length}`; };

        const where: string[] = [INBOX_ELIGIBILITY_SQL];
        if (params.delivery_zone_id !== undefined) where.push(`d.delivery_zone_id = ${bind(params.delivery_zone_id)}`);
        if (params.priority) where.push(`d.priority = ${bind(params.priority)}`);
        if (params.shift) where.push(`(${SHIFT_SQL}) = ${bind(params.shift)}`);
        if (params.search) {
            const like = bind(`%${escapeLike(params.search)}%`);
            where.push(`(d.contact_name ILIKE ${like} OR d.tracking_code ILIKE ${like})`);
        }
        const whereSql = `WHERE ${where.join(' AND ')}`;

        // Default: urgent first, then the earliest SLA deadline (no deadline last). Every order ends in the id,
        // so a page never repeats or skips a row when the sorted field ties.
        const direction = params.order === 'desc' ? 'DESC' : 'ASC';
        const orderSql = params.sortBy
            ? `ORDER BY ${SORT_SQL[params.sortBy]} ${direction} NULLS LAST, d.dispatch_id ASC`
            : `ORDER BY ${URGENT_FIRST_SQL} ASC, ${SLA_DUE_SQL} ASC NULLS LAST, d.dispatch_id ASC`;

        const [{ total }] = await this.dataSource.query(`SELECT COUNT(*)::int AS total ${FROM_SQL} ${whereSql}`, args);

        const rows: Row[] = await this.dataSource.query(
            `SELECT d.dispatch_id AS id, d.source_order_ref AS order_number, d.tracking_code,
                    d.contact_name AS recipient, d.contact_phone AS recipient_phone, d.delivery_address AS address,
                    d.delivery_zone_id AS zone_id, z.name AS zone_name, ${SHIFT_SQL} AS shift,
                    d.scheduled_window_start AS window_start, d.scheduled_window_end AS window_end,
                    d.priority, s.name AS status, ${SLA_DUE_SQL} AS sla_due_at,
                    pk.packages_count, pk.weight_kg, pk.volume_m3,
                    r.reserved_by, u.full_name AS reserved_by_name, r.expires_at AS reservation_expires_at
             ${FROM_SQL} ${whereSql} ${orderSql}
             LIMIT ${bind(limit)} OFFSET ${bind((page - 1) * limit)}`,
            args,
        );

        return { data: rows.map((row) => this.toDto(row, userId)), total, page, limit };
    }

    private toDto(row: Row, userId: number): PendingOrderDto {
        const reserved = row.reserved_by !== null;
        const mine = reserved && row.reserved_by === userId;
        return {
            id: row.id,
            orderNumber: row.order_number,
            trackingCode: row.tracking_code,
            recipient: row.recipient,
            recipientPhone: row.recipient_phone,
            address: row.address,
            zoneId: row.zone_id,
            zoneName: row.zone_name,
            shift: row.shift,
            windowStart: row.window_start,
            windowEnd: row.window_end,
            priority: row.priority,
            // While a live reservation exists the order is shown as in planning, whoever holds it.
            status: reserved ? 'in_planning' : row.status,
            slaDueAt: row.sla_due_at,
            packagesCount: Number(row.packages_count),
            weightKg: Number(row.weight_kg),
            volumeM3: Number(row.volume_m3),
            locked: reserved && !mine,
            reservation: reserved
                ? {
                    reservedById: row.reserved_by!,
                    reservedByName: row.reserved_by_name!,
                    expiresAt: row.reservation_expires_at!,
                    reservedByMe: mine,
                }
                : null,
        };
    }
}
