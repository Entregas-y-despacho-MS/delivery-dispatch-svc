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
    /** Route day. `null` leaves the dispatch without a route. */
    shiftDate?: string | null;
    windowStart?: Date;
    windowEnd?: Date;
}

export interface TrackedDispatch {
    dispatchId: number;
    token: string;
    trackingCode: string;
    ref: string;
    routeBatchId: number | null;
}

/**
 * Dispatches that already went through the 1st approval (they have a `tracking_token`), inserted straight
 * into the database so a suite can put each one in the exact state it needs. Everything carries the suite's
 * tag and is removed by `cleanup()`.
 */
export class TrackedFixtures {
    private readonly refs: string[] = [];
    private readonly batchIds: number[] = [];
    private readonly dispatchIds: number[] = [];
    private seq = 0;

    constructor(private readonly db: DataSource, private readonly tag: string) {}

    async create(options: TrackedDispatchOptions = {}): Promise<TrackedDispatch> {
        const status = options.status ?? 'scheduled';
        const [{ dispatch_type_id }] = await this.db.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);
        const [{ dispatch_status_id }] = await this.db.query(`SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $1`, [status]);
        const [{ warehouse_id }] = await this.db.query(`SELECT warehouse_id FROM warehouses WHERE active = TRUE ORDER BY warehouse_id LIMIT 1`);

        let routeBatchId: number | null = null;
        if (options.shiftDate !== null) {
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
                    scheduled_window_start, scheduled_window_end, version)
             VALUES ($1, $2, $3, $4, $5, 'Calle Secreta 123', 'E2E customer', '+591 70000000', $6, 1, $7,
                     next_tracking_code(), $8, $9, $10, $11, $12, $13, 1)
             RETURNING dispatch_id, tracking_code`,
            [
                dispatch_type_id, dispatch_status_id, routeBatchId, routeBatchId === null ? null : 1, ref, email, warehouse_id,
                token, options.tokenExpiresAt ?? null, options.customerConfirmation ?? 'pending', notifiedAt,
                options.windowStart ?? new Date('2026-10-20T13:00:00Z'), options.windowEnd ?? new Date('2026-10-20T15:00:00Z'),
            ],
        );
        const dispatchId = Number(row.dispatch_id);
        this.dispatchIds.push(dispatchId);
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
        });
    }
}
