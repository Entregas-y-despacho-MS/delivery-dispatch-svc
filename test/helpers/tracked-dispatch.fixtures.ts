import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { withEventPurge } from './purge-append-only-events.js';

export interface TrackedDispatchOptions {
    status?: string;
    customerConfirmation?: string;
    /** `undefined` = a valid notice 1 h ago; `null` = the notice never reached the customer. */
    notifiedAt?: Date | null;
    /** `undefined` = an email; `null` = none. */
    email?: string | null;
    tokenExpiresAt?: Date | null;
    /** Route day of the batch created for it. `null` leaves the dispatch without a route. Ignored with `routeBatchId`. */
    shiftDate?: string | null;
    windowStart?: Date;
    windowEnd?: Date;
    /** One package, so the preparation order can be built. `false` leaves the dispatch without packages. */
    packages?: boolean;
    /** Put the dispatch in a batch made with `createBatch` instead of a new bare one. */
    routeBatchId?: number;
    sequence?: number;
    zoneId?: number;
    warehouseId?: number;
    /** Where it is delivered: `km` kilometres south of the warehouse (the OSRM double drives 1 km in 60 s). */
    km?: number;
    weightKg?: number;
    orderConfirmedAt?: Date;
}

export interface TrackedDispatch {
    dispatchId: number;
    token: string;
    trackingCode: string;
    ref: string;
    routeBatchId: number | null;
}

export interface FixtureWarehouse {
    id: number;
    code: string;
    lat: number;
    lon: number;
}

/**
 * Dispatches that already went through the 1st approval (they have a `tracking_token`), inserted straight
 * into the database so a suite can put each one in the exact state it needs, plus the zones, vehicles and open
 * batches the rescheduling looks at. Everything carries the suite's tag and is removed by `cleanup()`.
 */
export class TrackedFixtures {
    private readonly refs: string[] = [];
    private readonly batchIds: number[] = [];
    private readonly dispatchIds: number[] = [];
    private readonly vehicleIds: number[] = [];
    private readonly zoneIds: number[] = [];
    private seq = 0;
    private plateSeq = 0;

    constructor(private readonly db: DataSource, private readonly tag: string) {}

    /** The active warehouses, with their point on the map. */
    async warehouses(): Promise<FixtureWarehouse[]> {
        const rows = await this.db.query(`SELECT warehouse_id, code, latitude, longitude FROM warehouses WHERE active = TRUE AND deleted_at IS NULL ORDER BY warehouse_id`);
        return rows.map((row: any) => ({ id: row.warehouse_id, code: row.code, lat: Number(row.latitude), lon: Number(row.longitude) }));
    }

    async createZone(label: string): Promise<number> {
        const [{ delivery_zone_id }] = await this.db.query(
            `INSERT INTO delivery_zones (code, name, estimated_time_min) VALUES ($1, $2, 30) RETURNING delivery_zone_id`,
            [`Z${this.tag.slice(-8)}${label}`.slice(0, 20), `Zona e2e ${this.tag} ${label}`],
        );
        this.zoneIds.push(delivery_zone_id);
        return delivery_zone_id;
    }

    async createVehicle(capacityKg = 1000): Promise<number> {
        const [{ vehicle_status_id }] = await this.db.query(`SELECT vehicle_status_id FROM vehicle_statuses WHERE name = 'active'`);
        const [{ vehicle_id }] = await this.db.query(
            `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3)
             VALUES ($1, 'camioneta', 'E2E public tracking', $2, $3, 50) RETURNING vehicle_id`,
            [vehicle_status_id, `T${this.tag.slice(-6)}${++this.plateSeq}`.slice(0, 15), capacityKg],
        );
        this.vehicleIds.push(vehicle_id);
        return vehicle_id;
    }

    /** An open (provisional) batch with a vehicle, in a zone and a warehouse. */
    async createBatch(options: { shiftDate: string; vehicleId: number; zoneId: number; warehouseId: number; status?: string }): Promise<number> {
        const [{ route_batch_id }] = await this.db.query(
            `INSERT INTO route_batches (status, shift_date, vehicle_id, delivery_zone_id, origin_warehouse_id)
             VALUES ($1, $2, $3, $4, $5) RETURNING route_batch_id`,
            [options.status ?? 'provisional', options.shiftDate, options.vehicleId, options.zoneId, options.warehouseId],
        );
        this.batchIds.push(route_batch_id);
        return Number(route_batch_id);
    }

    async create(options: TrackedDispatchOptions = {}): Promise<TrackedDispatch> {
        const status = options.status ?? 'scheduled';
        const [{ dispatch_type_id }] = await this.db.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);
        const [{ dispatch_status_id }] = await this.db.query(`SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $1`, [status]);
        const [first] = await this.warehouses();
        const warehouse = options.warehouseId === undefined ? first : (await this.warehouses()).find((w) => w.id === options.warehouseId)!;

        let routeBatchId: number | null = options.routeBatchId ?? null;
        if (routeBatchId === null && options.shiftDate !== null) {
            const [batch] = await this.db.query(
                `INSERT INTO route_batches (status, shift_date) VALUES ('provisional', $1) RETURNING route_batch_id`,
                [options.shiftDate ?? '2026-10-20'],
            );
            routeBatchId = Number(batch.route_batch_id);
            this.batchIds.push(routeBatchId);
        }

        const ref = `${this.tag}-${++this.seq}`;
        this.refs.push(ref);
        const token = randomUUID();
        const notifiedAt = options.notifiedAt === undefined ? new Date(Date.now() - 60 * 60_000) : options.notifiedAt;
        const email = options.email === undefined ? 'customer@example.test' : options.email;
        const [row] = await this.db.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order, source_order_ref,
                    delivery_address, contact_name, contact_phone, contact_email, estimated_weight_kg, origin_warehouse_id,
                    tracking_code, tracking_token, tracking_token_expires_at, customer_confirmation, promise_notified_at,
                    scheduled_window_start, scheduled_window_end, version, delivery_zone_id, delivery_latitude, delivery_longitude,
                    order_confirmed_at, shipment_ready)
             VALUES ($1, $2, $3, $4, $5, 'Calle Secreta 123', 'E2E customer', '+591 70000000', $6, $14, $7,
                     next_tracking_code(), $8, $9, $10, $11, $12, $13, 1, $15, $16, $17, $18, TRUE)
             RETURNING dispatch_id, tracking_code`,
            [
                dispatch_type_id, dispatch_status_id, routeBatchId, routeBatchId === null ? null : (options.sequence ?? 1), ref, email, warehouse.id,
                token, options.tokenExpiresAt ?? null, options.customerConfirmation ?? 'pending', notifiedAt,
                options.windowStart ?? new Date('2026-10-20T13:00:00Z'), options.windowEnd ?? new Date('2026-10-20T15:00:00Z'),
                options.weightKg ?? 1, options.zoneId ?? null,
                options.km === undefined ? null : warehouse.lat - options.km * 0.01, options.km === undefined ? null : warehouse.lon,
                options.orderConfirmedAt ?? new Date(),
            ],
        );
        const dispatchId = Number(row.dispatch_id);
        this.dispatchIds.push(dispatchId);
        if (options.packages !== false) {
            await this.db.query(
                `INSERT INTO dispatch_packages (dispatch_id, external_package_id, length_cm, width_cm, height_cm, gross_weight_kg)
                 VALUES ($1, $2, 40, 30, 25, 6.4)`,
                [dispatchId, `${ref}-PKG-1`],
            );
        }
        return { dispatchId, token, trackingCode: row.tracking_code, ref, routeBatchId };
    }

    /** One `customer` rescheduling row, as the self-service writes them. */
    async addCustomerRescheduling(dispatchId: number): Promise<void> {
        const [{ reschedule_reason_id }] = await this.db.query(`SELECT reschedule_reason_id FROM reschedule_reasons WHERE code = 'RES-CLI-SELF'`);
        await this.db.query(
            `INSERT INTO dispatch_reschedules (dispatch_id, reschedule_reason_id, rescheduled_by_type, new_window_start, new_window_end)
             VALUES ($1, $2, 'customer', '2026-10-21T13:00:00Z', '2026-10-21T15:00:00Z')`,
            [dispatchId, reschedule_reason_id],
        );
    }

    async cleanup(): Promise<void> {
        await withEventPurge(this.db, { dispatchRefs: this.refs.map((ref) => `${ref}%`), routeBatchIds: this.batchIds }, async (manager) => {
            await manager.query(`DELETE FROM outbound_messages WHERE payload->'data'->>'salesOrderId' LIKE $1`, [`${this.tag}%`]);
            await manager.query(`DELETE FROM dispatch_reschedules WHERE dispatch_id = ANY($1::int[])`, [this.dispatchIds]);
            await manager.query(`DELETE FROM dispatch_packages WHERE dispatch_id = ANY($1::int[])`, [this.dispatchIds]);
            await manager.query(`DELETE FROM dispatches WHERE source_order_ref = ANY($1::text[])`, [this.refs]);
            await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [this.batchIds]);
            await manager.query(`DELETE FROM vehicles WHERE vehicle_id = ANY($1::int[])`, [this.vehicleIds]);
            await manager.query(`DELETE FROM delivery_zones WHERE delivery_zone_id = ANY($1::int[])`, [this.zoneIds]);
        });
    }
}
