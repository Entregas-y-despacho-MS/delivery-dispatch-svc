// ST-60.1 — GET /fleet/live-positions: mapa en vivo de la flota (RF-A13).
//
// Levanta el AppModule real contra una base real. Todo lo que crea lleva un prefijo único por corrida y se borra en afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';

describe('GET /fleet/live-positions (e2e, ST-60.1)', () => {
    let app: INestApplication;
    let db: DataSource;
    let prefix: string;
    const run = Date.now().toString(36).toUpperCase();
    const tag = 'e2e_fleet_';
    const tokens: Record<string, string> = {};
    const refs: string[] = [];
    const batchIds: number[] = [];
    const vehicleIds: number[] = [];
    const statusIds: Record<string, number> = {};
    let deliveryTypeId: number;
    let activeVehicleStatusId: number;
    let zoneId: number;
    let driverId: number;
    let driver2Id: number;

    const http = () => request(app.getHttpServer());
    const api = (path: string) => `/${prefix}${path}`;
    const livePositions = (key = 'coordinator') => http().get(api('/fleet/live-positions')).set({ Authorization: `Bearer ${tokens[key]}` });

    const createUser = async (key: string, role: string): Promise<number> => {
        const username = `${tag}${key}_${run}`;
        const [{ user_id }] = await db.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change, active)
             VALUES ((SELECT role_id FROM roles WHERE name = $1), $2, $3, $4, FALSE, TRUE) RETURNING user_id`,
            [role, `Fleet ${key} ${run}`, username, await hashPassword('E2eTest1234')],
        );
        const res = await http().post(api('/auth/login')).send({ username, password: 'E2eTest1234' });
        tokens[key] = res.body.accessToken as string;
        return user_id as number;
    };

    const createVehicle = async (plate: string): Promise<number> => {
        const [{ vehicle_id }] = await db.query(
            `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3)
             VALUES ($1, 'van', 'Hiace e2e', $2, 100, 10) RETURNING vehicle_id`,
            [activeVehicleStatusId, plate],
        );
        vehicleIds.push(vehicle_id);
        return vehicle_id as number;
    };

    let nextShiftDay = 2;

    const createBatch = async (status: string, driver: number, vehicle: number, zone: number | null): Promise<number> => {
        const shiftDate = `2040-01-${String(nextShiftDay++).padStart(2, '0')}`; // one per batch — driver/vehicle are unique per non-cancelled shift_date
        const [{ route_batch_id }] = await db.query(
            `INSERT INTO route_batches (status, shift_date, driver_id, vehicle_id, delivery_zone_id, version)
             VALUES ($1, $2, $3, $4, $5, 0) RETURNING route_batch_id`,
            [status, shiftDate, driver, vehicle, zone],
        );
        batchIds.push(route_batch_id);
        return route_batch_id as number;
    };

    const insertDispatch = async (
        status: string, batchId: number, sequence: number,
        position: { lat: number; lng: number; at: string } | null = null,
    ): Promise<number> => {
        const ref = `FLEET-${run}-${refs.length}`;
        refs.push(ref);
        const [{ dispatch_id }] = await db.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order, source_order_ref,
                 delivery_address, contact_name, last_latitude, last_longitude, last_location_at)
             VALUES ($1, $2, $3, $4, $5, 'Av. e2e 123', 'E2E customer', $6, $7, $8) RETURNING dispatch_id`,
            [deliveryTypeId, statusIds[status], batchId, sequence, ref, position?.lat ?? null, position?.lng ?? null, position?.at ?? null],
        );
        return dispatch_id as number;
    };

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
        for (const s of await db.query(`SELECT dispatch_status_id AS id, name FROM dispatch_statuses`)) statusIds[s.name] = s.id;
        [{ delivery_zone_id: zoneId }] = await db.query(
            `INSERT INTO delivery_zones (code, name, estimated_time_min) VALUES ($1, $2, 30) RETURNING delivery_zone_id`,
            [`FL${run}`.slice(0, 20), `Zona fleet ${run}`],
        );

        await createUser('coordinator', 'coordinator');
        await createUser('supervisor', 'supervisor');
        driverId = await createUser('driver', 'driver');
        driver2Id = await createUser('driver2', 'driver');
    });

    afterAll(async () => {
        if (db) {
            await db.query(`DELETE FROM dispatches WHERE source_order_ref = ANY($1::text[])`, [refs]);
            await db.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
            await db.query(`DELETE FROM vehicles WHERE vehicle_id = ANY($1::int[])`, [vehicleIds]);
            await db.query(`DELETE FROM delivery_zones WHERE delivery_zone_id = $1`, [zoneId]);
            await db.query(`DELETE FROM users WHERE username LIKE $1`, [`${tag}%_${run}`]);
        }
        await app?.close();
    });

    it('returns the in_transit stop and its own last position when one is in_transit', async () => {
        const vehicle = await createVehicle(`F1${run.slice(-6)}`);
        const batchId = await createBatch('in_execution', driverId, vehicle, zoneId);
        await insertDispatch('out_for_delivery', batchId, 1);
        const current = await insertDispatch('in_transit', batchId, 2, { lat: -17.783, lng: -63.182, at: '2040-01-02T10:05:00Z' });

        const res = await livePositions();
        expect(res.status).toBe(200);
        const row = res.body.find((r: { routeBatchId: number }) => r.routeBatchId === batchId);
        expect(row).toMatchObject({
            routeBatchId: batchId, driverId, vehicleId: vehicle,
            deliveryZone: { id: zoneId, name: `Zona fleet ${run}` },
            currentStop: { dispatchId: current, status: 'in_transit' },
            lastLatitude: -17.783, lastLongitude: -63.182, lastLocationAt: '2040-01-02T10:05:00.000Z',
        });
    });

    it('falls back to the next open stop and to the most recent position of the batch when the current one has none', async () => {
        const vehicle = await createVehicle(`F2${run.slice(-6)}`);
        const batchId = await createBatch('in_execution', driver2Id, vehicle, zoneId);
        await insertDispatch('delivered', batchId, 1, { lat: -17.70, lng: -63.10, at: '2040-01-02T09:00:00Z' });
        const next = await insertDispatch('out_for_delivery', batchId, 2); // no position yet

        const res = await livePositions();
        const row = res.body.find((r: { routeBatchId: number }) => r.routeBatchId === batchId);
        expect(row).toMatchObject({
            currentStop: { dispatchId: next, status: 'out_for_delivery' },
            lastLatitude: -17.70, lastLongitude: -63.10, lastLocationAt: '2040-01-02T09:00:00.000Z',
        });
    });

    it('skips an already-resolved incident stop and reports the next real open one as the current stop', async () => {
        const vehicle = await createVehicle(`F5${run.slice(-6)}`);
        const batchId = await createBatch('in_execution', driverId, vehicle, zoneId);
        await insertDispatch('incident', batchId, 1); // already handled — not where the driver is working now
        const next = await insertDispatch('out_for_delivery', batchId, 2);

        const res = await livePositions();
        const row = res.body.find((r: { routeBatchId: number }) => r.routeBatchId === batchId);
        expect(row).toMatchObject({ currentStop: { dispatchId: next, status: 'out_for_delivery' } });
    });

    it('returns a null zone and a null current stop when there is none to show', async () => {
        const vehicle = await createVehicle(`F3${run.slice(-6)}`);
        const batchId = await createBatch('in_execution', driverId, vehicle, null);
        await insertDispatch('delivered', batchId, 1);

        const res = await livePositions();
        const row = res.body.find((r: { routeBatchId: number }) => r.routeBatchId === batchId);
        expect(row).toMatchObject({ deliveryZone: null, currentStop: null, lastLatitude: null, lastLongitude: null, lastLocationAt: null });
    });

    it('excludes a route batch that is not in_execution', async () => {
        const vehicle = await createVehicle(`F4${run.slice(-6)}`);
        const confirmedBatchId = await createBatch('confirmed', driverId, vehicle, zoneId);
        await insertDispatch('assigned', confirmedBatchId, 1);

        const res = await livePositions();
        expect(res.body.some((r: { routeBatchId: number }) => r.routeBatchId === confirmedBatchId)).toBe(false);
    });

    it('requires coordinator or supervisor role', async () => {
        expect((await livePositions('supervisor')).status).toBe(200);
        expect((await livePositions('driver')).status).toBe(403);
    });

    it('requires authentication', async () => {
        const res = await http().get(api('/fleet/live-positions'));
        expect(res.status).toBe(401);
    });
});
