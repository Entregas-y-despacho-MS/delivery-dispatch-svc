import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { todayInOperatingTimeZone } from '../../modules/dispatch/dispatches/utils/operating-date.util.js';
import { MANUAL_SOURCE_REF_PREFIX, PickupOrderService } from '../../modules/messaging/rma-pickup-intake/services/pickup-order.service.js';
import { DISPATCH_STATUS_CHANGED_EVENT } from '../dispatch-status/dispatch-status-changed.event.js';
import type { CreatePickupOrderDto } from './dto/create-pickup-order.dto.js';
import type { FindPickupOrdersParamsDto } from './dto/find-pickup-orders-params.dto.js';
import type { FindPickupOrdersResponseDto } from './dto/find-pickup-orders-response.dto.js';
import type { PickupOrderDto } from './dto/pickup-order.dto.js';
import { InvalidPickupDateRangeException, PickupDateInPastException, PickupOrderNotFoundException } from './exceptions/index.js';

interface PickupOrderRow {
    id: number;
    tracking_code: string | null;
    source_order_ref: string;
    origin: 'manual' | 'rma';
    status: string;
    contact_name: string | null;
    contact_phone: string | null;
    contact_email: string | null;
    address: string;
    reference: string | null;
    latitude: string | null;
    longitude: string | null;
    return_reason: string | null;
    package_contents: string | null;
    estimated_boxes: number | null;
    preferred_pickup_date: string | null;
    warehouse_id: number | null;
    warehouse_code: string | null;
    warehouse_name: string | null;
    created_at: Date;
    receipt_result: 'complete' | 'with_differences' | 'rejected' | null;
}

/** Origin of an order, told from its `source_order_ref` (`MANUAL-` is reserved, ST-81.2 D2). */
export const ORIGIN_SQL = `CASE WHEN d.source_order_ref LIKE '${MANUAL_SOURCE_REF_PREFIX}%' THEN 'manual' ELSE 'rma' END`;

export const PICKUP_ORDER_SELECT = `
    SELECT d.dispatch_id AS id, d.tracking_code, d.source_order_ref, ${ORIGIN_SQL} AS origin, ds.name AS status,
           d.contact_name, d.contact_phone, d.contact_email, d.delivery_address AS address, d.delivery_reference AS reference,
           d.delivery_latitude AS latitude, d.delivery_longitude AS longitude, d.return_reason, d.package_contents,
           d.estimated_boxes,
           to_char(d.preferred_pickup_date AT TIME ZONE 'America/La_Paz', 'YYYY-MM-DD') AS preferred_pickup_date,
           w.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name, d.created_at,
           (SELECT r.result FROM warehouse_receipts r
             WHERE r.dispatch_id = d.dispatch_id AND r.status = 'applied'
             ORDER BY r.received_at DESC, r.record_version DESC LIMIT 1) AS receipt_result
      FROM dispatches d
      JOIN dispatch_types dt ON dt.dispatch_type_id = d.dispatch_type_id
      JOIN dispatch_statuses ds ON ds.dispatch_status_id = d.dispatch_status_id
      LEFT JOIN warehouses w ON w.warehouse_id = d.destination_warehouse_id
     WHERE dt.name = 'warehouse_return_pickup'`;

export function toPickupOrderDto(row: PickupOrderRow): PickupOrderDto {
    return {
        id: row.id,
        trackingCode: row.tracking_code,
        sourceOrderRef: row.source_order_ref,
        origin: row.origin,
        status: row.status,
        contactName: row.contact_name,
        contactPhone: row.contact_phone,
        contactEmail: row.contact_email,
        address: row.address,
        reference: row.reference,
        latitude: row.latitude === null ? null : Number(row.latitude),
        longitude: row.longitude === null ? null : Number(row.longitude),
        returnReason: row.return_reason,
        packageContents: row.package_contents,
        estimatedBoxes: row.estimated_boxes,
        preferredPickupDate: row.preferred_pickup_date,
        destinationWarehouse: row.warehouse_id === null
            ? null
            : { id: row.warehouse_id, code: row.warehouse_code as string, name: row.warehouse_name as string },
        createdAt: new Date(row.created_at).toISOString(),
        receiptResult: row.receipt_result ?? null,
    };
}

/**
 * Customer pickup orders for the Recojos page (ES-81, RF-A39): creation by hand, cancellation and listing. The pickup
 * rules live in `PickupOrderService` (shared with the RMA consumer) and `DispatchCancelService`; this class only
 * opens the transaction, announces the change to the web and shapes the response.
 */
@Injectable()
export class PickupOrdersService {
    private readonly logger = new Logger(PickupOrdersService.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly pickups: PickupOrderService,
        private readonly events: EventEmitter2,
    ) {}

    async create(dto: CreatePickupOrderDto, userId: number, now: Date = new Date()): Promise<PickupOrderDto> {
        const today = todayInOperatingTimeZone(now);
        if (dto.preferredPickupDate < today) throw new PickupDateInPastException(dto.preferredPickupDate, today);

        const created = await this.dataSource.transaction(async (manager) => {
            return await this.pickups.createManual(dto, userId, { manager });
        });
        this.announceCreated(created.dispatchId, created.status, now);
        return await this.findOne(created.dispatchId);
    }

    /** Filtered, paginated list, newest first. Parameterized SQL: every value goes through a placeholder. */
    async findAll(params: FindPickupOrdersParamsDto): Promise<FindPickupOrdersResponseDto> {
        const { page, limit, status, from, to, origin } = params;
        if (from && to && to < from) throw new InvalidPickupDateRangeException();

        const args: unknown[] = [];
        const bind = (value: unknown): string => {
            args.push(value);
            return `$${args.length}`;
        };
        const where: string[] = [];
        if (status) where.push(`ds.name = ${bind(status)}`);
        if (origin === 'manual') where.push(`d.source_order_ref LIKE '${MANUAL_SOURCE_REF_PREFIX}%'`);
        if (origin === 'rma') where.push(`d.source_order_ref NOT LIKE '${MANUAL_SOURCE_REF_PREFIX}%'`);
        if (from) where.push(`(d.preferred_pickup_date AT TIME ZONE 'America/La_Paz')::date >= ${bind(from)}::date`);
        if (to) where.push(`(d.preferred_pickup_date AT TIME ZONE 'America/La_Paz')::date <= ${bind(to)}::date`);
        const filters = where.map((clause) => ` AND ${clause}`).join('');

        const [{ total }] = (await this.dataSource.query(
            `SELECT COUNT(*)::int AS total FROM (${PICKUP_ORDER_SELECT}${filters}) AS filtered`,
            [...args], // a copy: the page query below adds LIMIT and OFFSET to `args`
        )) as { total: number }[];
        const rows = (await this.dataSource.query(
            `${PICKUP_ORDER_SELECT}${filters} ORDER BY d.dispatch_id DESC LIMIT ${bind(limit)} OFFSET ${bind((page - 1) * limit)}`,
            args,
        )) as PickupOrderRow[];

        return { data: rows.map(toPickupOrderDto), meta: { page, limit, total, pages: Math.ceil(total / limit) } };
    }

    async findOne(id: number, manager: EntityManager = this.dataSource.manager): Promise<PickupOrderDto> {
        const [row] = (await manager.query(`${PICKUP_ORDER_SELECT} AND d.dispatch_id = $1`, [id])) as PickupOrderRow[];
        if (!row) throw new PickupOrderNotFoundException();
        return toPickupOrderDto(row);
    }

    /** The order is committed; a failing listener must not turn the creation into an error. */
    private announceCreated(dispatchId: number, status: string, now: Date): void {
        try {
            this.events.emit(DISPATCH_STATUS_CHANGED_EVENT, {
                dispatchId,
                status,
                previousStatus: status,
                version: 0,
                updatedAt: now.toISOString(),
            });
        } catch (error) {
            this.logger.error(`A listener of ${DISPATCH_STATUS_CHANGED_EVENT} failed for dispatch ${dispatchId}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
