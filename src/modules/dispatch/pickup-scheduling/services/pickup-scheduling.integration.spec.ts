import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { DataSource, type EntityManager, type QueryRunner } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MessageValidator } from '../../../../plugins/messaging/envelope/message-validator.js';
import { OutboxService } from '../../../messaging/outbound-messages/services/outbox.service.js';
import { ProcurementPickupRepository } from '../../../messaging/procurement-pickup-intake/repositories/procurement-pickup.repository.js';
import {
    DispatchNotSchedulableException,
    PickupWindowsDoNotIntersectException,
} from '../exceptions/index.js';
import { PickupSchedulingService } from './pickup-scheduling.service.js';

/**
 * Against PostgreSQL with the delivery-dispatch-db schema loaded (migration 015 or later). Skipped
 * unless TEST_DB_PORT is set:
 *   TEST_DB_HOST=localhost TEST_DB_PORT=5434 TEST_DB_USER=... TEST_DB_PASSWORD=... TEST_DB_NAME=... \
 *     npx vitest run pickup-scheduling.integration
 *
 * Every test runs inside one transaction that is rolled back, so no dispatch, vehicle, incident,
 * event or outbox row stays in the database.
 */
const PORT = process.env.TEST_DB_PORT;
const RUN = randomBytes(4).toString('hex');
// A Tuesday, well ahead of every `now` used below.
const SUPPLIER_DAY = '2026-10-20';
const NOW = new Date('2026-10-14T12:00:00Z');

describe.skipIf(!PORT)('PickupSchedulingService against PostgreSQL', () => {
    let dataSource: DataSource;
    let runner: QueryRunner;
    let counter = 0;

    const manager = (): EntityManager => runner.manager;
    const validator = MessageValidator.fromDirectory(resolve(process.cwd(), 'contracts/messages'));

    /** The real service, but its "transaction" is the test's own, so the rollback undoes everything. */
    const service = (): PickupSchedulingService => {
        const sameTransaction = { transaction: async (cb: (m: EntityManager) => unknown) => await cb(manager()) };
        const settings = {
            getString: async (_key: string, fallback: string) => fallback,
            getNumber: async (_key: string, fallback: number) => fallback,
        };
        return new PickupSchedulingService(
            sameTransaction as never,
            settings as never,
            new OutboxService(sameTransaction as never, validator),
        );
    };

    const one = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
        ((await manager().query(sql, params)) as T[])[0];

    const warehouse = async () =>
        await one<{ warehouse_id: number; code: string; reception_start_time: string; reception_end_time: string }>(
            `SELECT warehouse_id, code, reception_start_time, reception_end_time
               FROM warehouses WHERE active = TRUE AND deleted_at IS NULL ORDER BY warehouse_id LIMIT 1`,
        );

    /** A throwaway coordinator, created inside the test transaction: the database may have no seeded users. */
    const actorId = async (): Promise<number> => {
        const created = await one<{ user_id: number }>(
            `INSERT INTO users (role_id, full_name, username, password_hash)
             VALUES ((SELECT role_id FROM roles WHERE name = 'coordinator'), 'IT coordinator', $1, 'not-a-real-hash')
             RETURNING user_id`,
            [`it-${RUN}-${++counter}`],
        );
        return created.user_id;
    };

    const createVehicle = async (capacityKg: number, capacityM3: number): Promise<number> => {
        const created = await one<{ vehicle_id: number }>(
            `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3)
             VALUES ((SELECT vehicle_status_id FROM vehicle_statuses ORDER BY vehicle_status_id LIMIT 1),
                     'truck', 'IT model', $1, $2, $3)
             RETURNING vehicle_id`,
            [`IT${RUN.slice(0, 5)}${++counter}`, capacityKg, capacityM3],
        );
        return created.vehicle_id;
    };

    /** A `pending` supplier pickup built by the real intake (ST-74.1), with the supplier window of the given hours. */
    const createPickup = async (supplierStartUtc: string, supplierEndUtc: string): Promise<{ id: number; orderId: string }> => {
        const wh = await warehouse();
        const orderId = `IT-PO-${RUN}-${++counter}`;
        await new ProcurementPickupRepository().applyRequested(
            {
                purchaseOrderId: orderId,
                recordVersion: 1,
                updatedAt: '2026-10-14T11:00:00Z',
                approvedAt: '2026-10-14T10:00:00Z',
                supplier: { supplierId: 'SUP-IT', name: 'Proveedor de prueba' },
                contact: { name: 'Contacto de prueba', phone: '+59170000000', email: 'pickup-it@example.com' },
                pickupAddress: {
                    line: 'Planta Norte, Calle 5',
                    reference: 'Portón azul',
                    location: { latitude: -16.5, longitude: -68.1 },
                },
                pickupWindow: { startsAt: supplierStartUtc, endsAt: supplierEndUtc },
                warehouseId: wh.code,
                products: [{ productId: 'SKU-IT', quantity: 2 }],
                estimates: { weightKg: 18, volumeM3: 0.5 },
            } as never,
            { manager: manager() },
        );
        const row = await one<{ id: number }>(
            `SELECT dispatch_id AS id FROM dispatches
              WHERE source_order_ref = $1
                AND dispatch_type_id = (SELECT dispatch_type_id FROM dispatch_types WHERE name = 'supplier_pickup')`,
            [orderId],
        );
        return { id: row.id, orderId };
    };

    const dispatchState = async (id: number) =>
        await one<{ status: string; start: Date; end: Date; tracking_code: string | null }>(
            `SELECT s.name AS status, d.scheduled_window_start AS start, d.scheduled_window_end AS end, d.tracking_code
               FROM dispatches d JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
              WHERE d.dispatch_id = $1`,
            [id],
        );

    const outboxFor = async (orderId: string) =>
        (await manager().query(
            `SELECT type, payload->'data' AS data FROM outbound_messages
              WHERE payload->'data'->>'purchaseOrderId' = $1 ORDER BY created_at, type`,
            [orderId],
        )) as { type: string; data: Record<string, unknown> }[];

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'postgres',
            host: process.env.TEST_DB_HOST ?? 'localhost',
            port: Number(PORT),
            username: process.env.TEST_DB_USER,
            password: process.env.TEST_DB_PASSWORD,
            database: process.env.TEST_DB_NAME,
        });
        await dataSource.initialize();
    });

    beforeEach(async () => {
        runner = dataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
    });

    afterEach(async () => {
        await runner.rollbackTransaction();
        await runner.release();
    });

    afterAll(async () => {
        await dataSource?.destroy();
    });

    it('schedules inside the intersection, assigns the tracking code and queues a valid message', async () => {
        const pickup = await createPickup(`${SUPPLIER_DAY}T00:00:00Z`, `${SUPPLIER_DAY}T23:00:00Z`);
        const vehicleId = await createVehicle(1000, 8);

        const result = await service().schedule(pickup.id, { vehicleId }, await actorId(), NOW);

        expect(result.status).toBe('scheduled');
        expect(result.recordVersion).toBe(1);
        expect(result.trackingCode).toMatch(/^DSP-\d{4}-\d{5}$/);

        const state = await dispatchState(pickup.id);
        expect(state.status).toBe('scheduled');
        expect(state.tracking_code).toBe(result.trackingCode);
        expect(state.start.toISOString()).toBe(result.pickupWindow.startsAt);
        expect(state.end.toISOString()).toBe(result.pickupWindow.endsAt);

        const messages = await outboxFor(pickup.orderId);
        expect(messages).toHaveLength(1);
        expect(messages[0].type).toBe('dispatch.pickup.scheduled');
        expect(messages[0].data).toMatchObject({ recordVersion: 1, trackingCode: result.trackingCode });

        const event = await one<{ event_type: string; metadata: Record<string, unknown> }>(
            `SELECT event_type, metadata FROM dispatch_events WHERE dispatch_id = $1 AND event_type = 'pickup_scheduled'`,
            [pickup.id],
        );
        expect(event.metadata).toMatchObject({
            recordVersion: 1,
            supplierWindow: { startsAt: `${SUPPLIER_DAY}T00:00:00.000Z`, endsAt: `${SUPPLIER_DAY}T23:00:00.000Z` },
        });
    });

    it('answers 409 and leaves the dispatch pending when there is no common time', async () => {
        // The supplier window opens one hour after the warehouse closes (La Paz is UTC-4, no daylight saving).
        const wh = await warehouse();
        const [endHour, endMinute] = wh.reception_end_time.split(':').map(Number);
        const closes = new Date(`${SUPPLIER_DAY}T00:00:00Z`);
        closes.setUTCHours(endHour + 4, endMinute);
        const closedStart = new Date(closes.getTime() + 3_600_000).toISOString();
        const closedEnd = new Date(closes.getTime() + 2 * 3_600_000).toISOString();
        const pickup = await createPickup(closedStart, closedEnd);
        const vehicleId = await createVehicle(1000, 8);

        await expect(service().schedule(pickup.id, { vehicleId }, await actorId(), NOW)).rejects.toBeInstanceOf(
            PickupWindowsDoNotIntersectException,
        );

        expect((await dispatchState(pickup.id)).status).toBe('pending');
        expect(await outboxFor(pickup.orderId)).toHaveLength(0);
    });

    it('refuses to schedule the same pickup twice', async () => {
        const pickup = await createPickup(`${SUPPLIER_DAY}T00:00:00Z`, `${SUPPLIER_DAY}T23:00:00Z`);
        const vehicleId = await createVehicle(1000, 8);
        const actor = await actorId();
        await service().schedule(pickup.id, { vehicleId }, actor, NOW);

        await expect(service().schedule(pickup.id, { vehicleId }, actor, NOW)).rejects.toBeInstanceOf(
            DispatchNotSchedulableException,
        );
        expect(await outboxFor(pickup.orderId)).toHaveLength(1);
    });

    it('reschedules: records incident and coordinator reschedule, and publishes both messages with version 2', async () => {
        const pickup = await createPickup(`${SUPPLIER_DAY}T00:00:00Z`, `${SUPPLIER_DAY}T23:00:00Z`);
        const vehicleId = await createVehicle(1000, 8);
        const actor = await actorId();
        const scheduled = await service().schedule(pickup.id, { vehicleId }, actor, NOW);

        const incidentReason = await one<{ incident_reason_id: number }>(
            `SELECT incident_reason_id FROM incident_reasons WHERE active = TRUE AND deleted_at IS NULL ORDER BY incident_reason_id LIMIT 1`,
        );
        const rescheduleReason = await one<{ reschedule_reason_id: number }>(
            `SELECT reschedule_reason_id FROM reschedule_reasons WHERE active = TRUE AND deleted_at IS NULL ORDER BY reschedule_reason_id LIMIT 1`,
        );
        // Same warehouse hours, one day later: the slot of the first scheduling shifted by 24 h.
        const first = new Date(scheduled.pickupWindow.startsAt);
        const second = new Date(scheduled.pickupWindow.endsAt);
        const window = {
            startsAt: new Date(first.getTime() + 24 * 3_600_000),
            endsAt: new Date(second.getTime() + 24 * 3_600_000),
        };

        const result = await service().reschedule(
            pickup.id,
            {
                incidentReasonId: incidentReason.incident_reason_id,
                rescheduleReasonId: rescheduleReason.reschedule_reason_id,
                window,
                description: 'Supplier had no load ready',
            },
            actor,
            NOW,
        );

        expect(result.recordVersion).toBe(2);
        expect((await dispatchState(pickup.id)).status).toBe('scheduled');
        expect((await dispatchState(pickup.id)).start.toISOString()).toBe(window.startsAt.toISOString());

        const incident = await one<{ incident_reason_id: number }>(
            `SELECT incident_reason_id FROM dispatch_incidents WHERE dispatch_incident_id = $1`,
            [result.incidentId],
        );
        expect(incident.incident_reason_id).toBe(incidentReason.incident_reason_id);
        const reschedule = await one<{ rescheduled_by_type: string; rescheduled_by: number; new_window_start: Date }>(
            `SELECT rescheduled_by_type, rescheduled_by, new_window_start FROM dispatch_reschedules WHERE dispatch_id = $1`,
            [pickup.id],
        );
        expect(reschedule.rescheduled_by_type).toBe('coordinator');
        expect(reschedule.rescheduled_by).toBe(actor);
        expect(reschedule.new_window_start.toISOString()).toBe(window.startsAt.toISOString());

        const messages = await outboxFor(pickup.orderId);
        expect(messages.map((m) => m.type).sort()).toEqual([
            'dispatch.pickup.scheduled',
            'dispatch.pickup.scheduled',
            'dispatch.transfer.incident_reported',
        ]);
        const versions = messages.map((m) => Number(m.data.recordVersion)).sort();
        expect(versions).toEqual([1, 2, 2]);
    });
});
