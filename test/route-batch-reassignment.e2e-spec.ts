// ST-63.1 (ES-63, ES-286) — reasignación de paradas out_for_delivery entre dos route_batches in_execution.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

describe('POST /route-batches/:id/reassign (e2e, ST-63.1)', () => {
    let app: INestApplication;
    let db: DataSource;
    let prefix: string;

    const run = Date.now().toString(36).toUpperCase();
    const tag = `ST631-${run}`;
    const usernames: string[] = [];
    const vehicleIds: number[] = [];
    const zoneIds: number[] = [];
    const batchIds: number[] = [];
    const refs: string[] = [];
    const reasonIds: number[] = [];
    const tokens: Record<string, string> = {};
    const users: Record<string, number> = {};
    let activeVehicleStatusId: number;
    let deliveryTypeId: number;
    let statusIds: Record<string, number> = {};
    let reasonCode: string;
    let nextShiftDay = 1;

    const http = () => request(app.getHttpServer());
    const api = (path: string) => `/${prefix}${path}`;
    const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

    let plateSequence = 0;
    const createVehicle = async (capacityKg = 100, capacityM3 = 10): Promise<number> => {
        const plate = `${run.slice(-8)}${(plateSequence++).toString(36).toUpperCase()}`;
        const [{ vehicle_id }] = await db.query(
            `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3) VALUES ($1, 'van', 'Hiace e2e', $2, $3, $4) RETURNING vehicle_id`,
            [activeVehicleStatusId, plate, capacityKg, capacityM3],
        );
        vehicleIds.push(vehicle_id);
        return vehicle_id as number;
    };

    const createZone = async (code: string, name: string): Promise<number> => {
        const [{ delivery_zone_id }] = await db.query(
            `INSERT INTO delivery_zones (code, name, estimated_time_min) VALUES ($1, $2, 30) RETURNING delivery_zone_id`,
            [code, name],
        );
        zoneIds.push(delivery_zone_id);
        return delivery_zone_id as number;
    };

    const createBatch = async (driverId: number, vehicleId: number, zoneId: number | null): Promise<number> => {
        const shiftDate = `2041-01-${String(nextShiftDay++).padStart(2, '0')}`;
        const [{ route_batch_id }] = await db.query(
            `INSERT INTO route_batches (status, shift_date, driver_id, vehicle_id, delivery_zone_id, version) VALUES ('in_execution', $1, $2, $3, $4, 0) RETURNING route_batch_id`,
            [shiftDate, driverId, vehicleId, zoneId],
        );
        batchIds.push(route_batch_id);
        return route_batch_id as number;
    };

    const insertDispatch = async (status: string, batchId: number, sequence: number): Promise<number> => {
        const ref = `${tag}-${refs.length}`;
        refs.push(ref);
        const [{ dispatch_id }] = await db.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order, source_order_ref, delivery_address)
             VALUES ($1, $2, $3, $4, $5, 'Av. e2e 123') RETURNING dispatch_id`,
            [deliveryTypeId, statusIds[status], batchId, sequence, ref],
        );
        return dispatch_id as number;
    };

    const addPackage = async (dispatchId: number, weightKg: number): Promise<void> => {
        await db.query(
            `INSERT INTO dispatch_packages (dispatch_id, external_package_id, length_cm, width_cm, height_cm, gross_weight_kg) VALUES ($1, $2, 10, 10, 10, $3)`,
            [dispatchId, `${tag}-pkg-${dispatchId}`, weightKg],
        );
    };

    const batchRow = async (id: number) => (await db.query(`SELECT status, version FROM route_batches WHERE route_batch_id = $1`, [id]))[0];
    const dispatchRow = async (id: number) => {
        const [row] = await db.query(
            `SELECT d.route_batch_id, d.sequence_order, d.version, s.name AS status
               FROM dispatches d JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id WHERE d.dispatch_id = $1`,
            [id],
        );
        return row;
    };

    const reassign = (originId: number, body: object, who = 'coordinator') => http().post(api(`/route-batches/${originId}/reassign`)).set(auth(who)).send(body);
    const targets = (originId: number, who = 'coordinator') => http().get(api(`/route-batches/${originId}/reassignment-targets`)).set(auth(who));

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        prefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(prefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        db = moduleRef.get(DataSource);

        [{ vehicle_status_id: activeVehicleStatusId }] = await db.query(`SELECT vehicle_status_id FROM vehicle_statuses WHERE name = 'active'`);
        [{ dispatch_type_id: deliveryTypeId }] = await db.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);
        const rows = await db.query('SELECT name, dispatch_status_id FROM dispatch_statuses');
        statusIds = Object.fromEntries(rows.map((r: { name: string; dispatch_status_id: number }) => [r.name, r.dispatch_status_id]));

        const passwordHash = await hashPassword('E2eTest1234');
        for (const who of ['driver1', 'driver2', 'coordinator', 'driver3']) {
            const role = who === 'coordinator' ? 'coordinator' : 'driver';
            const [{ role_id: roleId }] = await db.query('SELECT role_id FROM roles WHERE name = $1', [role]);
            const username = `e2e_st631_${who}_${run}`;
            usernames.push(username);
            const [{ user_id: id }] = await db.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1,$2,$3,$4,false) RETURNING user_id`,
                [roleId, `ST-63.1 ${who}`, username, passwordHash],
            );
            users[who] = id;
            const login = await http().post(api('/auth/login')).send({ username, password: 'E2eTest1234' });
            expect(login.status).toBe(200);
            tokens[who] = login.body.accessToken;
        }

        reasonCode = `${tag}-BREAKDOWN`;
        const [{ reschedule_reason_id: reasonId }] = await db.query(
            `INSERT INTO reschedule_reasons (code, name, category, active) VALUES ($1, $2, 'operations', TRUE) RETURNING reschedule_reason_id`,
            [reasonCode, `Avería ${tag}`],
        );
        reasonIds.push(reasonId);
    }, 30000);

    afterAll(async () => {
        if (db?.isInitialized) {
            await withEventPurge(db, { dispatchRefs: [`${tag}%`], routeBatchIds: batchIds, userNames: [`e2e_st631_%_${run}`] }, async (manager) => {
                await manager.query('DELETE FROM dispatch_packages WHERE dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE source_order_ref LIKE $1)', [`${tag}%`]);
                await manager.query('DELETE FROM dispatches WHERE source_order_ref LIKE $1', [`${tag}%`]);
                await manager.query('DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])', [batchIds]);
                await manager.query('DELETE FROM vehicles WHERE vehicle_id = ANY($1::int[])', [vehicleIds]);
                await manager.query('DELETE FROM delivery_zones WHERE delivery_zone_id = ANY($1::int[])', [zoneIds]);
                await manager.query('DELETE FROM reschedule_reasons WHERE reschedule_reason_id = ANY($1::int[])', [reasonIds]);
                await manager.query('DELETE FROM users WHERE username LIKE $1', [`e2e_st631_%_${run}`]);
            });
        }
        await app?.close();
    });

    it('moves a stop to the end of the destination sequence, bumping both versions and closing the origin if emptied', async () => {
        const vehicleA = await createVehicle();
        const vehicleB = await createVehicle();
        const zone = await createZone(`${tag}-Z1`, 'Zona Centro');
        const originId = await createBatch(users.driver1, vehicleA, zone);
        const targetId = await createBatch(users.driver2, vehicleB, zone);
        const moving = await insertDispatch('out_for_delivery', originId, 1);
        const existingTargetStop = await insertDispatch('out_for_delivery', targetId, 1);
        void existingTargetStop;

        const response = await reassign(originId, {
            dispatchIds: [moving], targetBatchId: targetId, reasonCode, version: 0, targetVersion: 0,
        });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ fromBatchId: originId, toBatchId: targetId, movedDispatchIds: [moving], fromVersion: 1, toVersion: 1, fromBatchClosed: true });

        const moved = await dispatchRow(moving);
        expect(moved).toMatchObject({ route_batch_id: targetId, sequence_order: 2, status: 'out_for_delivery' });

        const origin = await batchRow(originId);
        expect(origin).toMatchObject({ status: 'closed', version: 1 });
        const target = await batchRow(targetId);
        expect(target).toMatchObject({ status: 'in_execution', version: 1 });

        const events = await db.query(
            `SELECT route_batch_id, dispatch_id, event_type FROM route_batch_events WHERE route_batch_id = ANY($1::int[]) AND dispatch_id = $2 ORDER BY route_batch_event_id`,
            [[originId, targetId], moving],
        );
        expect(events).toEqual([
            { route_batch_id: originId, dispatch_id: moving, event_type: 'order_removed' },
            { route_batch_id: targetId, dispatch_id: moving, event_type: 'order_added' },
        ]);
    });

    it('409s on a stale version and leaves everything untouched (Escenario 2)', async () => {
        const vehicleA = await createVehicle();
        const vehicleB = await createVehicle();
        const originId = await createBatch(users.driver1, vehicleA, null);
        const targetId = await createBatch(users.driver2, vehicleB, null);
        const moving = await insertDispatch('out_for_delivery', originId, 1);

        const response = await reassign(originId, {
            dispatchIds: [moving], targetBatchId: targetId, reasonCode, version: 99, targetVersion: 0,
        });

        expect(response.status).toBe(409);
        expect(response.body.error).toBe('ROUTE_BATCH_VERSION_CONFLICT');
        expect(await dispatchRow(moving)).toMatchObject({ route_batch_id: originId, status: 'out_for_delivery' });
    });

    it('409s when the stop is not out_for_delivery (Escenario 3)', async () => {
        const vehicleA = await createVehicle();
        const vehicleB = await createVehicle();
        const originId = await createBatch(users.driver1, vehicleA, null);
        const targetId = await createBatch(users.driver2, vehicleB, null);
        const moving = await insertDispatch('in_transit', originId, 1);

        const response = await reassign(originId, {
            dispatchIds: [moving], targetBatchId: targetId, reasonCode, version: 0, targetVersion: 0,
        });

        expect(response.status).toBe(409);
        expect(response.body.error).toBe('DISPATCH_NOT_OUT_FOR_DELIVERY');
    });

    it('409s when the destination has no capacity left and rolls back the whole move', async () => {
        const vehicleA = await createVehicle();
        const vehicleB = await createVehicle(5, 1); // tiny vehicle
        const originId = await createBatch(users.driver1, vehicleA, null);
        const targetId = await createBatch(users.driver2, vehicleB, null);
        const moving = await insertDispatch('out_for_delivery', originId, 1);
        await addPackage(moving, 50); // way over the 5kg destination vehicle

        const response = await reassign(originId, {
            dispatchIds: [moving], targetBatchId: targetId, reasonCode, version: 0, targetVersion: 0,
        });

        expect(response.status).toBe(409);
        expect(response.body.error).toBe('ROUTE_CAPACITY_EXCEEDED');
        expect(await dispatchRow(moving)).toMatchObject({ route_batch_id: originId });
        expect(await batchRow(originId)).toMatchObject({ version: 0 }); // the whole transaction rolled back
    });

    it('rejects a dispatch outside the origin batch with 409 DISPATCH_NOT_IN_BATCH', async () => {
        const vehicleA = await createVehicle();
        const vehicleB = await createVehicle();
        const vehicleC = await createVehicle();
        const originId = await createBatch(users.driver1, vehicleA, null);
        const targetId = await createBatch(users.driver2, vehicleB, null);
        const elsewhere = await createBatch(users.driver3, vehicleC, null);
        const foreignDispatch = await insertDispatch('out_for_delivery', elsewhere, 1);

        const response = await reassign(originId, {
            dispatchIds: [foreignDispatch], targetBatchId: targetId, reasonCode, version: 0, targetVersion: 0,
        });

        expect(response.status).toBe(409);
        expect(response.body.error).toBe('DISPATCH_NOT_IN_BATCH');
    });

    it('400s on an inactive/unknown reasonCode', async () => {
        const vehicleA = await createVehicle();
        const vehicleB = await createVehicle();
        const originId = await createBatch(users.driver1, vehicleA, null);
        const targetId = await createBatch(users.driver2, vehicleB, null);
        const moving = await insertDispatch('out_for_delivery', originId, 1);

        const response = await reassign(originId, {
            dispatchIds: [moving], targetBatchId: targetId, reasonCode: `${tag}-NOPE`, version: 0, targetVersion: 0,
        });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe('RESCHEDULE_REASON_INVALID');
    });

    it('a driver cannot reassign or list targets (403)', async () => {
        const vehicleA = await createVehicle();
        const originId = await createBatch(users.driver1, vehicleA, null);

        expect((await reassign(originId, { dispatchIds: [1], targetBatchId: originId, reasonCode, version: 0, targetVersion: 0 }, 'driver3')).status).toBe(403);
        expect((await targets(originId, 'driver3')).status).toBe(403);
    });

    it('GET reassignment-targets lists the other in_execution batches of the same shift day with remaining capacity', async () => {
        const vehicleA = await createVehicle(200, 20);
        const vehicleB = await createVehicle(100, 10);
        const zone = await createZone(`${tag}-Z2`, 'Zona Norte');
        const originId = await createBatch(users.driver1, vehicleA, zone);
        const targetId = await createBatch(users.driver2, vehicleB, zone);
        // Same shift_date as originId, required for it to be a candidate — createBatch always advances the day, so force it manually.
        await db.query(`UPDATE route_batches SET shift_date = (SELECT shift_date FROM route_batches WHERE route_batch_id = $1) WHERE route_batch_id = $2`, [originId, targetId]);
        const existingStop = await insertDispatch('out_for_delivery', targetId, 1);
        await addPackage(existingStop, 20);

        const response = await targets(originId);

        expect(response.status).toBe(200);
        expect(response.body).toContainEqual(expect.objectContaining({
            routeBatchId: targetId, version: 0, driverId: users.driver2, vehicleId: vehicleB,
            zoneId: zone, zoneName: 'Zona Norte', remainingWeightKg: 80,
        }));
        expect(response.body.find((row: { routeBatchId: number }) => row.routeBatchId === originId)).toBeUndefined();
    });

    it('404s GET reassignment-targets for an unknown batch', async () => {
        const response = await targets(999_999_999);
        expect(response.status).toBe(404);
    });
});
