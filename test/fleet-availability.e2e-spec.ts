// ST-303.1 — HTTP/PostgreSQL acceptance checks for GET /fleet/availability.
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

type Actor = 'coordinator' | 'supervisor' | 'driver';

describe('GET /fleet/availability (e2e, ST-303.1)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const tokens: Record<Actor, string> = { coordinator: '', supervisor: '', driver: '' };
    const run = Date.now().toString(36).toUpperCase();
    const prefix = `E2E3031-${run}`;
    const usernames = (['coordinator', 'supervisor', 'driver'] as const).map((role) => `e2e_st3031_${role}_${run}`);
    const driverName = `ST-303.1 driver ${run}`;
    const from = '2026-06-01';
    const to = '2026-06-10';
    const ids = { active: 0, maintenance: 0, outOfService: 0, removed: 0, driver: 0, batches: [] as number[] };

    const get = (actor: Actor | null, query: Record<string, string | number> = {}) => {
        const req = request(app.getHttpServer()).get(`/${apiPrefix}/fleet/availability`).query(query);
        return actor ? req.set('Authorization', `Bearer ${tokens[actor]}`) : req;
    };
    const vehicleRow = (body: { vehicles: Array<{ vehicleId: number }> }, id: number) => body.vehicles.find((vehicle) => vehicle.vehicleId === id);

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        apiPrefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(apiPrefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        dataSource = moduleRef.get(DataSource);

        const passwordHash = await hashPassword('E2eTest1234');
        for (const role of ['coordinator', 'supervisor', 'driver'] as const) {
            const [{ role_id: roleId }] = await dataSource.query(`SELECT role_id FROM roles WHERE name = $1`, [role]);
            const [{ user_id: userId }] = await dataSource.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false) RETURNING user_id`,
                [roleId, role === 'driver' ? driverName : `ST-303.1 ${role} ${run}`, `e2e_st3031_${role}_${run}`, passwordHash],
            );
            if (role === 'driver') ids.driver = userId;
            const login = await request(app.getHttpServer()).post(`/${apiPrefix}/auth/login`).send({ username: `e2e_st3031_${role}_${run}`, password: 'E2eTest1234' });
            expect(login.status, `login ${role}`).toBe(200);
            tokens[role] = login.body.accessToken as string;
        }

        const statusId = async (name: string): Promise<number> => (await dataSource.query(`SELECT vehicle_status_id AS id FROM vehicle_statuses WHERE name = $1`, [name]))[0].id;
        const newVehicle = async (status: string, suffix: string): Promise<number> => (await dataSource.query(
            `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3) VALUES ($1, 'van', 'ST-303.1 e2e', $2, 1000, 10) RETURNING vehicle_id`,
            [await statusId(status), `${suffix}-${run}`.slice(0, 15)],
        ))[0].vehicle_id;
        ids.active = await newVehicle('active', 'A');
        ids.maintenance = await newVehicle('maintenance', 'M');
        ids.outOfService = await newVehicle('out_of_service', 'O');
        // Removed from the fleet (soft delete) while its status is still `active`: it is not a registered vehicle.
        ids.removed = await newVehicle('active', 'R');
        await dataSource.query(`UPDATE vehicles SET deleted_at = NOW() WHERE vehicle_id = $1`, [ids.removed]);

        // Two overlapping maintenances of the active vehicle: June 2–5 and June 4–8 (Bolivia days) = 7 days, not 11.
        await dataSource.query(
            `INSERT INTO vehicle_maintenances (vehicle_id, description, status, created_at, completed_at)
             VALUES ($1, $2, 'completed', '2026-06-02T16:00:00Z', '2026-06-05T16:00:00Z'),
                    ($1, $3, 'completed', '2026-06-04T16:00:00Z', '2026-06-08T16:00:00Z')`,
            [ids.active, `${prefix} one`, `${prefix} two`],
        );

        const [{ dispatch_type_id: typeId }] = await dataSource.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);
        const status: Record<string, number> = {};
        for (const row of await dataSource.query(`SELECT dispatch_status_id, name FROM dispatch_statuses`)) status[row.name] = row.dispatch_status_id;
        const newBatch = async (batchStatus: string, day: string): Promise<number> => {
            const [{ route_batch_id: id }] = await dataSource.query(
                `INSERT INTO route_batches (status, shift_date, driver_id, vehicle_id, version) VALUES ($1, $2::date, $3, $4, 0) RETURNING route_batch_id`,
                [batchStatus, day, batchStatus === 'provisional' ? null : ids.driver, ids.active],
            );
            ids.batches.push(id);
            return id;
        };
        let sequence = 0;
        const newDispatch = async (batchId: number, dispatchStatus: string, kg: number | null, m3: number | null, closed: boolean): Promise<void> => {
            sequence += 1;
            await dataSource.query(
                `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, source_order_ref, tracking_code, delivery_address, evidence_policy,
                                         estimated_weight_kg, estimated_volume_m3, closed_at)
                 VALUES ($1, $2, $3, $4, $5, 'Dirección E2E ST-303.1', 'hand_delivery_standard', $6, $7, $8::timestamptz)`,
                [typeId, status[dispatchStatus], batchId, `${prefix}-${sequence}`, `DSP-2031-${String(70000 + sequence)}`, kg, m3, closed ? '2026-06-03T16:00:00Z' : null],
            );
        };
        const approved = await newBatch('confirmed', '2026-06-03');
        await newDispatch(approved, 'delivered', 300, 2, true);
        await newDispatch(approved, 'delivered', 200, 1.5, true);
        await newDispatch(approved, 'delivered', null, 1, true);
        await newDispatch(approved, 'not_delivered', null, null, true);
        await newDispatch(approved, 'cancelled', 900, 9, false); // excluded from the load and from the attempts
        const provisional = await newBatch('provisional', '2026-06-04');
        await newDispatch(provisional, 'pending', 5000, 50, false); // a route not approved yet is never attributed
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) {
            await withEventPurge(dataSource, { dispatchRefs: [`${prefix}%`], routeBatchIds: ids.batches, userNames: usernames }, async (manager) => {
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${prefix}%`]);
                await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [ids.batches]);
                await manager.query(`DELETE FROM vehicle_maintenances WHERE description LIKE $1`, [`${prefix}%`]);
                await manager.query(`DELETE FROM vehicles WHERE vehicle_id = ANY($1::int[])`, [[ids.active, ids.maintenance, ids.outOfService, ids.removed]]);
                await manager.query(`DELETE FROM users WHERE username LIKE ANY($1::text[])`, [usernames]);
            });
        }
        await app?.close();
    });

    it('merges overlapping maintenance, attributes the load only from approved routes and keeps kg and m3 apart (supervisor)', async () => {
        const response = await get('supervisor', { from, to, vehicleId: ids.active });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ from, to, n: 1, units: { time: 'calendar_days', load: ['kg', 'm3'] }, cutoff: { kind: 'current' } });
        expect(response.body.vehicles[0]).toMatchObject({
            vehicleId: ids.active,
            fleetStatus: 'active',
            maintenance: { count: 2, calendarDays: 7, overlapsDetected: true },
            load: {
                routes: 1,
                n: 4,
                withoutWeight: 2,
                withoutVolume: 1,
                kg: { used: 500, capacity: 1000, ratio: 0.5 },
                m3: { used: 4.5, capacity: 10, ratio: 0.45 },
                unavailableReason: null,
            },
        });
        expect(response.body.maintenance).toEqual({ count: 2, calendarDays: 7, overlapsDetected: true });
    });

    it('gives the supervisor the deliveries and attempts of each driver with n, ignoring the cancelled dispatch', async () => {
        const response = await get('supervisor', { from, to, vehicleId: ids.active });

        expect(response.body.productivity).toEqual({
            detailRestricted: false,
            deliveredCount: 3,
            attemptCount: 4,
            drivers: [{ driverId: ids.driver, driverName, deliveredCount: 3, attemptCount: 4 }],
        });
        expect((await get('supervisor', { from, to, vehicleId: ids.active, driverId: ids.driver })).body.productivity.drivers).toHaveLength(1);
        expect((await get('supervisor', { from, to, vehicleId: ids.active, driverId: ids.driver + 100000 })).body.productivity).toMatchObject({ attemptCount: 0, drivers: [] });
    });

    it('gives the coordinator only the aggregate: no driver name in the body, and the driver filter is refused', async () => {
        const response = await get('coordinator', { from, to, vehicleId: ids.active });

        expect(response.status).toBe(200);
        // Fleet-wide aggregate (not narrowed by vehicle), so it includes at least this suite's 3 deliveries / 4 attempts.
        expect(response.body.productivity).toMatchObject({ detailRestricted: true, drivers: [] });
        expect(response.body.productivity.deliveredCount).toBeGreaterThanOrEqual(3);
        expect(response.body.productivity.attemptCount).toBeGreaterThanOrEqual(4);
        expect(JSON.stringify(response.body)).not.toContain(driverName);
        const forbidden = await get('coordinator', { from, to, driverId: ids.driver });
        expect(forbidden.status).toBe(403);
        expect(forbidden.body.error).toBe('DRIVER_DETAIL_FORBIDDEN');
    });

    it('answers N/D for the load of a vehicle without approved routes', async () => {
        const response = await get('supervisor', { from, to, vehicleId: ids.maintenance });

        expect(response.body.vehicles[0]).toMatchObject({
            fleetStatus: 'maintenance',
            maintenance: { count: 0, calendarDays: 0, overlapsDetected: false },
            load: { kg: null, m3: null, routes: 0, n: 0, unavailableReason: 'no_route_in_period' },
        });
    });

    it('classifies assignable, maintenance and out of service over the registered vehicles', async () => {
        const response = await get('supervisor');
        const [counts] = await dataSource.query(
            `SELECT COUNT(*)::int AS registered,
                    COUNT(*) FILTER (WHERE vs.name = 'active')::int AS assignable,
                    COUNT(*) FILTER (WHERE vs.name = 'maintenance')::int AS in_maintenance,
                    COUNT(*) FILTER (WHERE vs.name = 'out_of_service')::int AS out_of_service
               FROM vehicles v JOIN vehicle_statuses vs ON vs.vehicle_status_id = v.vehicle_status_id WHERE v.deleted_at IS NULL`,
        );

        expect(response.body.availability).toEqual({ assignable: counts.assignable, registered: counts.registered, inMaintenance: counts.in_maintenance, outOfService: counts.out_of_service, unavailableReason: null });
        expect(response.body.n).toBe(counts.registered);
    });

    it('narrows the list by fleetStatus and vehicleId without changing what the summary counts', async () => {
        const maintenanceOnly = await get('supervisor', { fleetStatus: 'maintenance' });
        expect(maintenanceOnly.body.vehicles.length).toBeGreaterThan(0);
        expect(maintenanceOnly.body.vehicles.every((vehicle: { fleetStatus: string }) => vehicle.fleetStatus === 'maintenance')).toBe(true);
        expect(vehicleRow(maintenanceOnly.body, ids.maintenance)).toBeDefined();

        const mismatch = await get('supervisor', { fleetStatus: 'out_of_service', vehicleId: ids.active });
        expect(mismatch.body.vehicles).toEqual([]);
        expect(mismatch.body.n).toBe(0);
        expect(mismatch.body.availability).toMatchObject({ registered: 1, assignable: 1 });
    });

    it('filters the maintenance by routine / incident type without dropping the vehicle', async () => {
        const routine = await get('supervisor', { from, to, vehicleId: ids.active, routine: 'true' });
        expect(routine.body.vehicles[0].maintenance).toMatchObject({ count: 2, calendarDays: 7 });
        const withType = await get('supervisor', { from, to, vehicleId: ids.active, routine: 'false' });
        expect(withType.body.vehicles[0].maintenance).toEqual({ count: 0, calendarDays: 0, overlapsDetected: false });
        const unknownType = await get('supervisor', { from, to, vehicleId: ids.active, maintenanceTypeId: 2147483647 });
        expect(unknownType.body.vehicles[0].maintenance.count).toBe(0);
    });

    it('answers a past cut-off with the availability as N/D but the maintenance of the period as real data', async () => {
        const response = await get('supervisor', { cutoff: '2026-06-05', from, to, vehicleId: ids.active });

        expect(response.status).toBe(200);
        expect(response.body.cutoff).toEqual({ date: '2026-06-05', kind: 'past' });
        expect(response.body.availability).toEqual({ assignable: null, registered: null, inMaintenance: null, outOfService: null, unavailableReason: 'no_status_history' });
        expect(response.body.vehicles[0]).toMatchObject({ fleetStatus: null, maintenance: { count: 2, calendarDays: 7 } });
    });

    it('does not count a vehicle removed from the fleet, even if its status is still active', async () => {
        const asked = await get('supervisor', { vehicleId: ids.removed });
        expect(asked.body).toMatchObject({ n: 0, vehicles: [], availability: { registered: 0, assignable: 0 } });
        const all = await get('supervisor');
        expect(vehicleRow(all.body, ids.removed)).toBeUndefined();
    });

    it('says "Sin datos" with n = 0 when no vehicle matches', async () => {
        const response = await get('supervisor', { vehicleId: 2147483647 });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ n: 0, vehicles: [], maintenance: { count: 0, calendarDays: 0 } });
    });

    it('rejects a future cut-off, a reversed range and invalid values with HTTP 400', async () => {
        const future = await get('supervisor', { cutoff: '2999-01-01' });
        expect(future.status).toBe(400);
        expect(future.body.error).toBe('CUTOFF_IN_FUTURE');
        const reversed = await get('supervisor', { from: '2026-06-05', to: '2026-06-04' });
        expect(reversed.status).toBe(400);
        expect(reversed.body.error).toBe('INVALID_DATE_RANGE');
        expect((await get('supervisor', { fleetStatus: 'broken' })).status).toBe(400);
        expect((await get('supervisor', { vehicleId: 0 })).status).toBe(400);
        expect((await get('supervisor', { routine: 'maybe' })).status).toBe(400);
    });

    it('allows coordinator and supervisor, while denying driver and anonymous callers', async () => {
        expect((await get('coordinator')).status).toBe(200);
        expect((await get('supervisor')).status).toBe(200);
        expect((await get('driver')).status).toBe(403);
        expect((await get(null)).status).toBe(401);
    });
});
