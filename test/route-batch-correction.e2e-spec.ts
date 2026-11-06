// ST-51.6 — Corrección del conductor y del vehículo de un lote (PATCH /route-batches/:id/driver y /vehicle)
// y nueva validación con las reglas del corte de D-1, de punta a punta.
//
// Levanta el AppModule real contra una base de datos real, con OSRM simulado (FakeOsrm). Todo lo que crea
// lleva un prefijo único y se borra en afterAll; las claves `stop_service_minutes` y `planning_margin_pct`
// se restauran a su valor original.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { OsrmPort } from '../src/plugins/osrm/osrm.port.js';
import { OsrmUnavailableException } from '../src/plugins/osrm/exceptions/index.js';
import { FakeOsrm } from '../src/app/planning/domain/plan-fixtures.helper-spec.js';
import { localInstant } from '../src/app/planning/domain/operating-calendar.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

interface StopSpec {
    km: number;
    window: [string, string];
    packages?: boolean;
}

describe('Route batch correction (e2e, ST-51.6)', () => {
    let app: INestApplication;
    let db: DataSource;
    let prefix: string;
    const run = Date.now().toString(36).toUpperCase();
    const refPrefix = `E2ECOR-${run}-`;
    const userPrefix = 'e2e_cor_';
    const fakeOsrm = new FakeOsrm();

    const originalSettings: Record<string, string> = {};
    const batchIds: number[] = [];
    const vehicleIds: number[] = [];
    const userIds: number[] = [];
    let zoneId = 0;
    let warehouse = { id: 0, lat: 0, lon: 0 };
    let scheduledStatusId = 0;
    let assignedStatusId = 0;
    let coordinatorId = 0;
    let coordinatorToken = '';
    let driverToken = '';
    let driverA = 0; // the driver the batches start with
    let driverB = 0;
    let driverC = 0;
    let driverInactive = 0;
    let driverBusy = 0;
    let seq = 0;
    let dayCursor = 0;

    const api = (path: string) => `/${prefix}${path}`;
    const auth = () => ({ Authorization: `Bearer ${coordinatorToken}` });
    const patch = (batchId: number, what: 'driver' | 'vehicle', body: Record<string, unknown>, headers: Record<string, string> = auth()) =>
        request(app.getHttpServer()).patch(api(`/route-batches/${batchId}/${what}`)).set(headers).send(body);
    const detail = (batchId: number) => request(app.getHttpServer()).get(api(`/route-batches/${batchId}`)).set(auth());

    const newVehicle = async (capacityKg: number, status = 'active'): Promise<number> => {
        const [{ vehicle_status_id }] = await db.query(`SELECT vehicle_status_id FROM vehicle_statuses WHERE name = $1`, [status]);
        const [{ vehicle_id }] = await db.query(
            `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3)
             VALUES ($1, 'camioneta', 'E2E correccion', $2, $3, 50) RETURNING vehicle_id`,
            [vehicle_status_id, `K${run}${vehicleIds.length}`.slice(0, 15), capacityKg],
        );
        vehicleIds.push(vehicle_id);
        return vehicle_id as number;
    };

    /** A batch of its own day (the vehicle and the driver are unique per day) with one stop per spec. */
    const makeBatch = async (options: {
        status?: string;
        vehicleId?: number | null;
        driverId?: number | null;
        shiftDate?: string;
        stops?: StopSpec[];
    } = {}) => {
        const shiftDate = options.shiftDate ?? new Date(Date.UTC(2027, 2, 1 + dayCursor++)).toISOString().slice(0, 10);
        const vehicleId = options.vehicleId === undefined ? await newVehicle(1000) : options.vehicleId;
        const driverId = options.driverId === undefined ? driverA : options.driverId;
        const [{ route_batch_id }] = await db.query(
            `INSERT INTO route_batches (status, version, shift_date, delivery_zone_id, origin_warehouse_id, vehicle_id,
                                        proposed_driver_id, reviewer_user_id)
             VALUES ($1, 4, $2::date, $3, $4, $5, $6, $7) RETURNING route_batch_id`,
            [options.status ?? 'pending_final_review', shiftDate, zoneId, warehouse.id, vehicleId, driverId, coordinatorId],
        );
        batchIds.push(route_batch_id);
        const dispatchIds: number[] = [];
        for (const [index, spec] of (options.stops ?? [{ km: 1, window: ['09:00', '11:00'] }]).entries()) {
            const [{ dispatch_id }] = await db.query(
                `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, delivery_zone_id, origin_warehouse_id, source_order_ref,
                                         delivery_address, delivery_latitude, delivery_longitude, estimated_weight_kg,
                                         order_confirmed_at, shipment_ready, route_batch_id, sequence_order,
                                         scheduled_window_start, scheduled_window_end, version)
                 VALUES ((SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'), $1, $2, $3, $4,
                         'Dirección de prueba', $5, $6, 10, NOW(), TRUE, $7, $8, $9, $10, 1)
                 RETURNING dispatch_id`,
                [scheduledStatusId, zoneId, warehouse.id, `${refPrefix}${++seq}`, warehouse.lat - spec.km * 0.01, warehouse.lon,
                 route_batch_id, index + 1, localInstant(shiftDate, spec.window[0]), localInstant(shiftDate, spec.window[1])],
            );
            dispatchIds.push(dispatch_id);
            if (spec.packages !== false) {
                await db.query(
                    `INSERT INTO dispatch_packages (dispatch_id, external_package_id, length_cm, width_cm, height_cm, gross_weight_kg)
                     VALUES ($1, $2, 20, 20, 20, 10)`,
                    [dispatch_id, `PKG-${dispatch_id}`],
                );
            }
        }
        return { batchId: route_batch_id as number, shiftDate, vehicleId: vehicleId as number | null, dispatchIds };
    };

    const makeConfirmedBatch = async () => {
        const batch = await makeBatch({ status: 'confirmed' });
        await db.query(
            `UPDATE route_batches SET driver_id = $2, proposed_driver_id = NULL WHERE route_batch_id = $1`,
            [batch.batchId, driverA],
        );
        await db.query(
            `UPDATE dispatches SET dispatch_status_id = $2 WHERE route_batch_id = $1`,
            [batch.batchId, assignedStatusId],
        );
        return batch;
    };

    const batchRow = async (id: number) => (await db.query(
        `SELECT status, version, vehicle_id, driver_id, proposed_driver_id, accepted_at FROM route_batches WHERE route_batch_id = $1`, [id]))[0];
    const eventsOf = async (id: number) => await db.query(
        `SELECT event_type, actor_user_id, actor_type, reason, metadata FROM route_batch_events
          WHERE route_batch_id = $1 ORDER BY route_batch_event_id`, [id]);
    const expectUntouched = async (id: number, before: { status: string; version: number; vehicle_id: number | null; proposed_driver_id: number | null }) => {
        expect(await batchRow(id)).toMatchObject({
            status: before.status, version: before.version, vehicle_id: before.vehicle_id, proposed_driver_id: before.proposed_driver_id,
        });
        expect(await eventsOf(id)).toEqual([]);
    };

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(OsrmPort).useValue(fakeOsrm)
            .compile();
        app = moduleRef.createNestApplication();
        prefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(prefix);
        app.useGlobalPipes(new ValidationPipe({
            transform: true, whitelist: true, forbidNonWhitelisted: true,
            transformOptions: { enableImplicitConversion: false },
        }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        db = moduleRef.get(DataSource);

        const roles: Record<string, number> = {};
        for (const r of await db.query(`SELECT role_id AS id, name FROM roles`)) roles[r.name] = r.id;
        [{ dispatch_status_id: scheduledStatusId }] = await db.query(`SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'scheduled'`);
        [{ dispatch_status_id: assignedStatusId }] = await db.query(`SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'assigned'`);

        const passwordHash = await hashPassword('E2eTest1234');
        const makeUser = async (key: string, role: string, active = true) => {
            const [{ user_id }] = await db.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change, active)
                 VALUES ($1, $2, $3, $4, false, $5) RETURNING user_id`,
                [roles[role], `Correccion ${key} ${run}`, `${userPrefix}${key}_${run}`, passwordHash, active],
            );
            userIds.push(user_id);
            return user_id as number;
        };
        coordinatorId = await makeUser('coordinator', 'coordinator');
        driverA = await makeUser('driverA', 'driver');
        driverB = await makeUser('driverB', 'driver');
        driverC = await makeUser('driverC', 'driver');
        driverBusy = await makeUser('driverBusy', 'driver');
        driverInactive = await makeUser('driverInactive', 'driver', false);
        const login = async (key: string) => (await request(app.getHttpServer()).post(api('/auth/login'))
            .send({ username: `${userPrefix}${key}_${run}`, password: 'E2eTest1234' })).body.accessToken as string;
        coordinatorToken = await login('coordinator');
        driverToken = await login('driverA');

        const [wh] = await db.query(`SELECT warehouse_id, latitude, longitude FROM warehouses WHERE active = TRUE ORDER BY warehouse_id LIMIT 1`);
        warehouse = { id: wh.warehouse_id, lat: Number(wh.latitude), lon: Number(wh.longitude) };
        [{ delivery_zone_id: zoneId }] = await db.query(
            `INSERT INTO delivery_zones (code, name, estimated_time_min) VALUES ($1, $2, 30) RETURNING delivery_zone_id`,
            [`CR${run}`.slice(0, 20), `Zona e2e correccion ${run}`],
        );

        // A fresh database has these two empty and the validation refuses to run without them.
        for (const [key, value] of [['stop_service_minutes', '15'], ['planning_margin_pct', '20']]) {
            const [row] = await db.query(`SELECT setting_value AS value FROM settings WHERE setting_key = $1`, [key]);
            originalSettings[key] = row?.value ?? '';
            const res = await request(app.getHttpServer()).put(api(`/settings/${key}`)).set(auth()).send({ value });
            expect(res.status).toBe(200);
        }
    });

    beforeEach(() => {
        fakeOsrm.failWith = null;
    });

    afterAll(async () => {
        for (const [key, value] of Object.entries(originalSettings)) {
            await db.query(`UPDATE settings SET setting_value = $1 WHERE setting_key = $2`, [value, key]);
        }
        await withEventPurge(db, { dispatchRefs: [`${refPrefix}%`], routeBatchIds: batchIds, userNames: [`${userPrefix}%_${run}`] }, async (manager) => {
            await manager.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${refPrefix}%`]);
            await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
            await manager.query(`DELETE FROM vehicles WHERE vehicle_id = ANY($1::int[])`, [vehicleIds]);
            await manager.query(`DELETE FROM delivery_zones WHERE delivery_zone_id = $1`, [zoneId]);
        });
        await db?.query(`DELETE FROM users WHERE user_id = ANY($1::int[])`, [userIds]);
        await app?.close();
    });

    describe('PATCH /route-batches/:id/driver', () => {
        it('changes the driver of a batch pending final review, passes the validation and leaves it in review', async () => {
            const { batchId, dispatchIds } = await makeBatch();

            const res = await patch(batchId, 'driver', { driverId: driverB, version: 4 });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                routeBatchId: batchId, version: 5, status: 'pending_final_review', proposedDriverId: driverB, changed: true, capacity: null,
                validation: { passed: true, failures: [] },
            });
            expect(await batchRow(batchId)).toMatchObject({ status: 'pending_final_review', version: 5, proposed_driver_id: driverB, driver_id: null });
            const events = await eventsOf(batchId);
            expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(['driver_changed', 'cutoff_validated']);
            expect(events[0]).toMatchObject({ actor_user_id: coordinatorId, actor_type: 'user' });
            expect(events[0].metadata).toMatchObject({ previous: driverA, current: driverB, previousVersion: 4, version: 5, previousStatus: 'pending_final_review', status: 'pending_final_review' });
            expect(events[1]).toMatchObject({ actor_user_id: null, actor_type: 'system', reason: null });
            expect(events[1].metadata).toMatchObject({ trigger: 'correction', correction: 'driver', correctedByUserId: coordinatorId });

            // The review screen reads the same result from the batch detail (ST-215.5) and the dispatches are untouched.
            const shown = await detail(batchId);
            expect(shown.status).toBe(200);
            expect(shown.body).toMatchObject({ version: 5, validation: { result: 'validated', failures: [] } });
            const [{ version }] = await db.query(`SELECT version FROM dispatches WHERE dispatch_id = $1`, [dispatchIds[0]]);
            expect(version).toBe(1);
        });

        it('sends the batch back to provisional with the reasons when the new validation fails, keeping the correction', async () => {
            const { batchId } = await makeBatch({ stops: [{ km: 1, window: ['09:00', '11:00'], packages: false }] });

            const res = await patch(batchId, 'driver', { driverId: driverB, version: 4 });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ version: 5, status: 'provisional', proposedDriverId: driverB, changed: true, validation: { passed: false } });
            expect(res.body.validation.failures.map((f: { code: string }) => f.code)).toEqual(['packages_missing']);
            expect(await batchRow(batchId)).toMatchObject({ status: 'provisional', version: 5, proposed_driver_id: driverB });
            const events = await eventsOf(batchId);
            expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(['driver_changed', 'cutoff_failed']);
            expect(events[0].metadata).toMatchObject({ previousStatus: 'pending_final_review', status: 'provisional' });
            expect(events[1]).toMatchObject({ reason: 'packages_missing' });
            expect(events[1].metadata).toMatchObject({ trigger: 'correction', status: 'provisional' });

            const shown = await detail(batchId);
            expect(shown.body).toMatchObject({ status: 'provisional', validation: { result: 'failed', reason: 'packages_missing' } });
        });

        it('fails the validation when a promised slot is no longer met', async () => {
            const { batchId } = await makeBatch({ stops: [{ km: 1, window: ['03:00', '04:00'] }] });

            const res = await patch(batchId, 'driver', { driverId: driverB, version: 4 });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ status: 'provisional' });
            expect(res.body.validation.failures.map((f: { code: string }) => f.code)).toEqual(['slot_not_met']);
        });

        it('assigns a driver to a provisional batch that had none: version +1, one event, no validation, no OSRM', async () => {
            const { batchId } = await makeBatch({ status: 'provisional', driverId: null });
            fakeOsrm.failWith = new OsrmUnavailableException();

            const res = await patch(batchId, 'driver', { driverId: driverB, version: 4 });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ version: 5, status: 'provisional', proposedDriverId: driverB, changed: true, validation: null });
            expect(await batchRow(batchId)).toMatchObject({ status: 'provisional', version: 5, proposed_driver_id: driverB });
            const events = await eventsOf(batchId);
            expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(['driver_changed']);
            expect(events[0].metadata).toMatchObject({ previous: null, current: driverB });
        });

        it('assigns the missing driver of a batch pending final review, which the cutoff only warned about', async () => {
            const { batchId } = await makeBatch({ driverId: null });

            const res = await patch(batchId, 'driver', { driverId: driverB, version: 4 });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ status: 'pending_final_review', proposedDriverId: driverB, validation: { passed: true, warnings: [] } });
        });

        it('rejects an inactive driver with 409 and changes nothing', async () => {
            const { batchId } = await makeBatch();
            const before = await batchRow(batchId);

            const res = await patch(batchId, 'driver', { driverId: driverInactive, version: 4 });

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('ROUTE_BATCH_DRIVER_NOT_AVAILABLE');
            await expectUntouched(batchId, before);
        });

        it('rejects a user who is not a driver with 409', async () => {
            const { batchId } = await makeBatch();
            const res = await patch(batchId, 'driver', { driverId: coordinatorId, version: 4 });
            expect(res.status).toBe(409);
            expect(res.body.error).toBe('ROUTE_BATCH_DRIVER_NOT_AVAILABLE');
        });

        it('rejects a driver who already has another live batch that day with 409 and changes nothing', async () => {
            const { batchId, shiftDate } = await makeBatch();
            const other = await makeBatch({ shiftDate, driverId: driverBusy, status: 'provisional' });
            expect(other.batchId).toBeGreaterThan(0);
            const before = await batchRow(batchId);

            const res = await patch(batchId, 'driver', { driverId: driverBusy, version: 4 });

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('ROUTE_BATCH_DRIVER_NOT_AVAILABLE');
            await expectUntouched(batchId, before);
        });

        it('rejects a stale version with 409 and changes nothing', async () => {
            const { batchId } = await makeBatch();
            const before = await batchRow(batchId);

            const res = await patch(batchId, 'driver', { driverId: driverB, version: 3 });

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('ROUTE_BATCH_VERSION_CONFLICT');
            await expectUntouched(batchId, before);
        });

        it.each(['confirmed', 'in_execution', 'closed', 'cancelled'])('rejects a %s batch with 409 ROUTE_BATCH_NOT_CORRECTABLE', async (status) => {
            const { batchId } = await makeBatch({ status });
            const before = await batchRow(batchId);

            const res = await patch(batchId, 'driver', { driverId: driverB, version: 4 });

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('ROUTE_BATCH_NOT_CORRECTABLE');
            await expectUntouched(batchId, before);
        });

        it('answers 200 and writes nothing when the driver is the one the batch already has', async () => {
            const { batchId } = await makeBatch();
            const before = await batchRow(batchId);

            const res = await patch(batchId, 'driver', { driverId: driverA, version: 4 });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ version: 4, changed: false, validation: null });
            await expectUntouched(batchId, before);
        });

        it('lets only one of two concurrent corrections with the same version through', async () => {
            const { batchId } = await makeBatch();

            const responses = await Promise.all([
                patch(batchId, 'driver', { driverId: driverB, version: 4 }),
                patch(batchId, 'driver', { driverId: driverC, version: 4 }),
            ]);

            expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
            expect(responses.find(({ status }) => status === 409)?.body.error).toBe('ROUTE_BATCH_VERSION_CONFLICT');
            expect((await batchRow(batchId)).version).toBe(5);
            expect((await eventsOf(batchId)).filter((e: { event_type: string }) => e.event_type === 'driver_changed')).toHaveLength(1);
        });

        it('answers 503 and changes nothing when OSRM does not answer for a batch pending final review', async () => {
            const { batchId } = await makeBatch();
            const before = await batchRow(batchId);
            fakeOsrm.failWith = new OsrmUnavailableException();

            const res = await patch(batchId, 'driver', { driverId: driverB, version: 4 });

            expect(res.status).toBe(503);
            expect(res.body.error).toBe('OSRM_UNAVAILABLE');
            await expectUntouched(batchId, before);
        });

        it('answers 404 for a batch that does not exist', async () => {
            const res = await patch(2147483000, 'driver', { driverId: driverB, version: 4 });
            expect(res.status).toBe(404);
            expect(res.body.error).toBe('ROUTE_BATCH_NOT_FOUND');
        });

        it('validates the body: version is required, ids are bounded, unknown fields are refused', async () => {
            const { batchId } = await makeBatch();
            expect((await patch(batchId, 'driver', { driverId: driverB })).status).toBe(400);
            expect((await patch(batchId, 'driver', { driverId: 0, version: 4 })).status).toBe(400);
            expect((await patch(batchId, 'driver', { driverId: 2147483648, version: 4 })).status).toBe(400);
            expect((await patch(batchId, 'driver', { driverId: driverB, version: 4, status: 'confirmed' })).status).toBe(400);
        });

        it('requires a token and the coordinator or supervisor role', async () => {
            const { batchId } = await makeBatch();
            expect((await patch(batchId, 'driver', { driverId: driverB, version: 4 }, {})).status).toBe(401);
            const forbidden = await patch(batchId, 'driver', { driverId: driverB, version: 4 }, { Authorization: `Bearer ${driverToken}` });
            expect(forbidden.status).toBe(403);
        });
    });

    describe('PATCH /route-batches/:id/vehicle', () => {
        it('changes the vehicle of a batch pending final review, reports the capacity and validates it again', async () => {
            const { batchId } = await makeBatch();
            const newer = await newVehicle(2000);

            const res = await patch(batchId, 'vehicle', { vehicleId: newer, version: 4 });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                routeBatchId: batchId, version: 5, status: 'pending_final_review', vehicleId: newer, proposedDriverId: driverA, changed: true,
                capacity: { assignable: true }, validation: { passed: true },
            });
            expect(await batchRow(batchId)).toMatchObject({ status: 'pending_final_review', version: 5, vehicle_id: newer });
            const events = await eventsOf(batchId);
            expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(['vehicle_changed', 'cutoff_validated']);
            expect(events[0]).toMatchObject({ actor_user_id: coordinatorId, actor_type: 'user' });
            expect(events[0].metadata).toMatchObject({ current: newer, previousVersion: 4, version: 5 });
        });

        it('sends the batch back to provisional when, with the new vehicle, the validation fails', async () => {
            const { batchId } = await makeBatch({ stops: [{ km: 1, window: ['03:00', '04:00'] }] });
            const newer = await newVehicle(2000);

            const res = await patch(batchId, 'vehicle', { vehicleId: newer, version: 4 });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ status: 'provisional', vehicleId: newer, validation: { passed: false } });
            expect(await batchRow(batchId)).toMatchObject({ status: 'provisional', vehicle_id: newer });
            expect((await eventsOf(batchId)).map((e: { event_type: string }) => e.event_type)).toEqual(['vehicle_changed', 'cutoff_failed']);
        });

        it('keeps working on a provisional batch and now raises the version and writes the event', async () => {
            const { batchId } = await makeBatch({ status: 'provisional' });
            const newer = await newVehicle(2000);
            fakeOsrm.failWith = new OsrmUnavailableException();

            const res = await patch(batchId, 'vehicle', { vehicleId: newer, version: 4 });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ version: 5, status: 'provisional', vehicleId: newer, capacity: { assignable: true }, validation: null });
            expect((await eventsOf(batchId)).map((e: { event_type: string }) => e.event_type)).toEqual(['vehicle_changed']);
        });

        it('assigns a vehicle to a batch that had none (a remnant of the cutoff)', async () => {
            const { batchId } = await makeBatch({ status: 'provisional', vehicleId: null, driverId: null });
            const newer = await newVehicle(1000);

            const res = await patch(batchId, 'vehicle', { vehicleId: newer, version: 4 });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ vehicleId: newer, proposedDriverId: null, status: 'provisional' });
            expect((await eventsOf(batchId))[0].metadata).toMatchObject({ previous: null, current: newer });
        });

        it('rejects a vehicle that does not fit the load with 409 and changes nothing', async () => {
            const { batchId } = await makeBatch();
            const before = await batchRow(batchId);
            const tiny = await newVehicle(1);

            const res = await patch(batchId, 'vehicle', { vehicleId: tiny, version: 4 });

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('ROUTE_CAPACITY_EXCEEDED');
            await expectUntouched(batchId, before);
        });

        it('rejects an inactive vehicle with 409', async () => {
            const { batchId } = await makeBatch();
            const before = await batchRow(batchId);
            const inMaintenance = await newVehicle(1000, 'maintenance');

            const res = await patch(batchId, 'vehicle', { vehicleId: inMaintenance, version: 4 });

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('ROUTE_BATCH_VEHICLE_NOT_ACTIVE');
            await expectUntouched(batchId, before);
        });

        it('rejects a vehicle that another batch holds the same day with 409, not with a 500', async () => {
            const { batchId, shiftDate } = await makeBatch();
            const before = await batchRow(batchId);
            const taken = await newVehicle(1000);
            await makeBatch({ shiftDate, vehicleId: taken, driverId: driverBusy, status: 'provisional' });

            const res = await patch(batchId, 'vehicle', { vehicleId: taken, version: 4 });

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('ROUTE_BATCH_RESOURCE_CONFLICT');
            await expectUntouched(batchId, before);
        });

        it('answers 404 for a vehicle that does not exist', async () => {
            const { batchId } = await makeBatch();
            const res = await patch(batchId, 'vehicle', { vehicleId: 2147483000, version: 4 });
            expect(res.status).toBe(404);
            expect(res.body.error).toBe('VEHICLE_NOT_FOUND');
        });

        it('rejects a stale version with 409', async () => {
            const { batchId } = await makeBatch();
            const newer = await newVehicle(2000);
            const res = await patch(batchId, 'vehicle', { vehicleId: newer, version: 3 });
            expect(res.status).toBe(409);
            expect(res.body.error).toBe('ROUTE_BATCH_VERSION_CONFLICT');
        });

        it('replaces the vehicle of a confirmed batch, preserves its route, and requires a new driver acceptance', async () => {
            const { batchId, vehicleId: previousVehicle, dispatchIds } = await makeConfirmedBatch();
            const oldAcceptanceId = uuidv7();
            const accepted = await request(app.getHttpServer()).post(api(`/route-batches/${batchId}/accept`))
                .set({ Authorization: `Bearer ${driverToken}` }).send({ eventId: oldAcceptanceId });
            expect(accepted.status).toBe(200);
            const dispatchBefore = (await db.query(
                `SELECT route_batch_id, sequence_order, version, updated_at, dispatch_status_id FROM dispatches WHERE dispatch_id = $1`,
                [dispatchIds[0]],
            ))[0];
            const newer = await newVehicle(2000);

            const res = await patch(batchId, 'vehicle', { vehicleId: newer, version: 4, reason: 'Avería detectada antes de salir' });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ routeBatchId: batchId, version: 5, status: 'confirmed', vehicleId: newer, changed: true, capacity: { assignable: true }, validation: null });
            expect(await batchRow(batchId)).toMatchObject({ status: 'confirmed', version: 5, vehicle_id: newer, driver_id: driverA, proposed_driver_id: null, accepted_at: null });
            const dispatchAfter = (await db.query(
                `SELECT route_batch_id, sequence_order, version, updated_at, dispatch_status_id FROM dispatches WHERE dispatch_id = $1`,
                [dispatchIds[0]],
            ))[0];
            expect(dispatchAfter).toMatchObject({
                route_batch_id: batchId,
                sequence_order: dispatchBefore.sequence_order,
                version: dispatchBefore.version + 1,
                dispatch_status_id: assignedStatusId,
            });
            expect(new Date(dispatchAfter.updated_at).getTime()).toBeGreaterThan(new Date(dispatchBefore.updated_at).getTime());
            const events = await eventsOf(batchId);
            expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(['batch_accepted', 'vehicle_changed']);
            expect(events[1]).toMatchObject({ actor_user_id: coordinatorId, actor_type: 'user', reason: 'Avería detectada antes de salir' });
            expect(events[1].metadata).toMatchObject({ previous: previousVehicle, current: newer, previousVersion: 4, version: 5, acceptanceRevoked: true });

            const staleRetry = await request(app.getHttpServer()).post(api(`/route-batches/${batchId}/accept`))
                .set({ Authorization: `Bearer ${driverToken}` }).send({ eventId: oldAcceptanceId });
            expect(staleRetry.status).toBe(409);
            expect(staleRetry.body.error).toBe('ROUTE_BATCH_ACCEPTANCE_REVOKED');

            const reaccepted = await request(app.getHttpServer()).post(api(`/route-batches/${batchId}/accept`))
                .set({ Authorization: `Bearer ${driverToken}` }).send({ eventId: uuidv7() });
            expect(reaccepted.status).toBe(200);
            expect((await batchRow(batchId)).accepted_at).not.toBeNull();
        });

        it('requires a reason to replace a confirmed vehicle and makes no change', async () => {
            const { batchId } = await makeConfirmedBatch();
            const before = await batchRow(batchId);
            const newer = await newVehicle(2000);

            const res = await patch(batchId, 'vehicle', { vehicleId: newer, version: 4, reason: '   ' });

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('ROUTE_BATCH_VEHICLE_CHANGE_REASON_REQUIRED');
            await expectUntouched(batchId, before);
        });

        it.each(['in_execution', 'closed', 'cancelled'])('rejects a %s batch with 409 ROUTE_BATCH_NOT_CORRECTABLE', async (status) => {
            const { batchId } = await makeBatch({ status });
            const newer = await newVehicle(2000);
            const before = await batchRow(batchId);

            const res = await patch(batchId, 'vehicle', { vehicleId: newer, version: 4, reason: 'Cambio de flota' });

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('ROUTE_BATCH_NOT_CORRECTABLE');
            await expectUntouched(batchId, before);
        });

        it('requires the version in the body', async () => {
            const { batchId } = await makeBatch();
            const newer = await newVehicle(2000);
            expect((await patch(batchId, 'vehicle', { vehicleId: newer })).status).toBe(400);
        });

        it('answers 503 and changes nothing when OSRM does not answer for a batch pending final review', async () => {
            const { batchId } = await makeBatch();
            const before = await batchRow(batchId);
            const newer = await newVehicle(2000);
            fakeOsrm.failWith = new OsrmUnavailableException();

            const res = await patch(batchId, 'vehicle', { vehicleId: newer, version: 4 });

            expect(res.status).toBe(503);
            await expectUntouched(batchId, before);
        });
    });

    describe('after a correction', () => {
        it('refuses the 2nd approval with the version read before the correction and accepts the corrected one', async () => {
            const second = await makeBatch();
            expect((await patch(second.batchId, 'driver', { driverId: driverB, version: 4 })).status).toBe(200);

            const old = await request(app.getHttpServer()).post(api(`/route-batches/${second.batchId}/approve-final`)).set(auth())
                .send({ version: 4, dispatches: [{ dispatchId: second.dispatchIds[0], version: 1 }] });
            expect(old.status).toBe(409);
            expect(old.body.error).toBe('ROUTE_BATCH_VERSION_CONFLICT');
            const fresh = await request(app.getHttpServer()).post(api(`/route-batches/${second.batchId}/approve-final`)).set(auth())
                .send({ version: 5, dispatches: [{ dispatchId: second.dispatchIds[0], version: 1 }] });
            expect(fresh.status).toBe(200);
            expect(fresh.body).toMatchObject({ routeBatchId: second.batchId, driverId: driverB });
        });
    });
});
