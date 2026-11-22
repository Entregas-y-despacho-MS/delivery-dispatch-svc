// ST-303.3 — metrics and privacy of GET /fleet/availability, checked against hand-computed figures. Complements the
// acceptance checks of ST-303.1 (fleet-availability.e2e-spec.ts) with what the test task asks for and those leave out:
// a vehicle without any history, a small sample (n = 1), the period and cut-off edges in Bolivia days, kg and m³ peaks
// that come from different routes, calendar days and never hours, N/D when an estimate is missing, and the driver
// detail: a role without it cannot rebuild per-driver figures, not even by narrowing to one vehicle.
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

type Caller = 'coordinator' | 'supervisor' | 'admin' | 'driver';

// A period no other suite uses: productivity counts the whole fleet, so only this suite's dispatches may close in it.
const FROM = '2024-02-01';
const TO = '2024-02-10';

/** Every key of a JSON value, nested ones included. */
function keysOf(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap(keysOf);
    if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
    return [];
}

describe('GET /fleet/availability — metrics and privacy (e2e, ST-303.3)', () => {
    let app: INestApplication;
    let db: DataSource;
    let api: string;
    const run = Date.now().toString(36).toUpperCase();
    const prefix = `E2E3033-${run}`;
    const tokens = {} as Record<Caller, string>;
    const usernames: string[] = [];
    const names = { first: `Repartidor Uno ${run}`, second: `Repartidor Dos ${run}` };
    const ids = { first: 0, second: 0, busy: 0, empty: 0, unestimated: 0, other: 0, batches: [] as number[] };

    const get = (caller: Caller | null, query: Record<string, string | number> = {}) => {
        const call = request(app.getHttpServer()).get(`/${api}/fleet/availability`).query(query);
        return caller ? call.set('Authorization', `Bearer ${tokens[caller]}`) : call;
    };
    const period = { from: FROM, to: TO, cutoff: TO };
    const vehicle = (body: { vehicles: Array<{ vehicleId: number }> }, id: number) => body.vehicles.find((row) => row.vehicleId === id) as any;

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        api = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(api);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        db = moduleRef.get(DataSource);

        const hash = await hashPassword('E2eTest1234!');
        const newUser = async (role: string, label: string, fullName: string): Promise<number> => {
            const username = `e2e_st3033_${label}_${run}`.toLowerCase();
            usernames.push(username);
            const [{ user_id }] = await db.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change)
                 VALUES ((SELECT role_id FROM roles WHERE name = $1), $2, $3, $4, false) RETURNING user_id`,
                [role, fullName, username, hash],
            );
            return user_id;
        };
        for (const role of ['coordinator', 'supervisor', 'admin', 'driver'] as const) {
            await newUser(role, role, `ST-303.3 ${role} ${run}`);
            const login = await request(app.getHttpServer()).post(`/${api}/auth/login`).send({ username: `e2e_st3033_${role}_${run}`.toLowerCase(), password: 'E2eTest1234!' });
            expect(login.status, `login ${role}`).toBe(200);
            tokens[role] = login.body.accessToken;
        }
        ids.first = await newUser('driver', 'first', names.first);
        ids.second = await newUser('driver', 'second', names.second);

        const newVehicle = async (label: string, capacityKg: number, capacityM3: number): Promise<number> => (await db.query(
            `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3)
             VALUES ((SELECT vehicle_status_id FROM vehicle_statuses WHERE name = 'active'), 'van', 'ST-303.3 e2e', $1, $2, $3) RETURNING vehicle_id`,
            [`${label}${run}`.slice(0, 15), capacityKg, capacityM3],
        ))[0].vehicle_id;
        ids.busy = await newVehicle('B', 1000, 5);
        ids.empty = await newVehicle('E', 800, 8); // no maintenance, no route, ever
        ids.unestimated = await newVehicle('U', 900, 9);
        ids.other = await newVehicle('O', 700, 7);

        const newBatch = async (vehicleId: number, driverId: number, status: string, day: string): Promise<number> => {
            const [{ route_batch_id }] = await db.query(
                `INSERT INTO route_batches (status, shift_date, driver_id, vehicle_id, version) VALUES ($1, $2::date, $3, $4, 0) RETURNING route_batch_id`,
                [status, day, driverId, vehicleId],
            );
            ids.batches.push(route_batch_id);
            return route_batch_id;
        };
        let sequence = 0;
        const trackingBase = 10_000 + Math.floor(Math.random() * 80_000);
        const newDispatch = async (batchId: number, status: string, kg: number | null, m3: number | null, closedAt: string | null) => {
            sequence += 1;
            await db.query(
                `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, source_order_ref, tracking_code, delivery_address,
                                         evidence_policy, estimated_weight_kg, estimated_volume_m3, closed_at)
                 VALUES ((SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'),
                         (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $1),
                         $2, $3, $4, 'Dirección E2E ST-303.3', 'hand_delivery_standard', $5, $6, $7::timestamptz)`,
                [status, batchId, `${prefix}-${sequence}`, `DSP-2033-${String(trackingBase + sequence).padStart(5, '0')}`, kg, m3, closedAt],
            );
        };

        // Vehicle B: route A (first driver) is the kg peak, route B (second driver) is the m³ peak and over capacity.
        const routeA = await newBatch(ids.busy, ids.first, 'confirmed', '2024-02-03');
        await newDispatch(routeA, 'delivered', 400, 1, '2024-02-03T15:00:00Z');
        await newDispatch(routeA, 'not_delivered', 100, 0.5, '2024-02-03T18:00:00Z');
        const routeB = await newBatch(ids.busy, ids.second, 'closed', '2024-02-06');
        await newDispatch(routeB, 'delivered', 50, 6, '2024-02-06T15:00:00Z');
        // Vehicle O: the first driver also closed one delivery on another vehicle, so narrowing to vehicle B changes the
        // figures (2 deliveries / 3 attempts overall for him, 1 / 2 on vehicle B).
        const routeD = await newBatch(ids.other, ids.first, 'confirmed', '2024-02-05');
        await newDispatch(routeD, 'delivered', 10, 0.1, '2024-02-05T15:00:00Z');
        // Vehicle U: one approved route whose only dispatch has no estimate, still open.
        const routeC = await newBatch(ids.unestimated, ids.second, 'in_execution', '2024-02-04');
        await newDispatch(routeC, 'out_for_delivery', null, null, null);

        await db.query(
            `INSERT INTO vehicle_maintenances (vehicle_id, description, status, created_at, completed_at) VALUES
                -- Open, created on Feb 7 at 23:30 in Bolivia (Feb 8 in UTC): Feb 7..10 = 4 days.
                ($1, $3, 'in_progress', '2024-02-08T03:30:00Z', NULL),
                -- Starts before the period: only Feb 1..3 count = 3 days.
                ($2, $4, 'completed', '2024-01-20T15:00:00Z', '2024-02-03T15:00:00Z'),
                -- Same Bolivia day = 1 calendar day, whatever the hours.
                ($2, $5, 'completed', '2024-02-07T13:00:00Z', '2024-02-07T15:00:00Z'),
                -- Ends before the period: not counted.
                ($2, $6, 'completed', '2024-01-02T15:00:00Z', '2024-01-05T15:00:00Z')`,
            [ids.busy, ids.unestimated, `${prefix} open`, `${prefix} crossing`, `${prefix} same day`, `${prefix} before`],
        );
    });

    afterAll(async () => {
        if (db?.isInitialized) {
            await withEventPurge(db, { dispatchRefs: [`${prefix}%`], routeBatchIds: ids.batches, userNames: usernames }, async (manager) => {
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${prefix}%`]);
                await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [ids.batches]);
                await manager.query(`DELETE FROM vehicle_maintenances WHERE description LIKE $1`, [`${prefix}%`]);
                await manager.query(`DELETE FROM vehicles WHERE vehicle_id = ANY($1::int[])`, [[ids.busy, ids.empty, ids.unestimated, ids.other]]);
                await manager.query(`DELETE FROM users WHERE username = ANY($1::text[])`, [usernames]);
            });
        }
        await app?.close();
    });

    describe('vehicle without history and N/D', () => {
        it('answers zero maintenance and an N/D load with its reason, never an invented 0', async () => {
            const res = await get('supervisor', { ...period, vehicleId: ids.empty });
            expect(res.status).toBe(200);
            expect(res.body.n).toBe(1);
            expect(vehicle(res.body, ids.empty)).toMatchObject({
                maintenance: { count: 0, calendarDays: 0, overlapsDetected: false },
                load: { kg: null, m3: null, routes: 0, n: 0, unavailableReason: 'no_route_in_period' },
            });
        });

        it('a route whose dispatches carry no estimate is N/D for kg and m³ (no_estimate), with the dispatch counted', async () => {
            const res = await get('supervisor', { ...period, vehicleId: ids.unestimated });
            expect(vehicle(res.body, ids.unestimated).load).toEqual({ kg: null, m3: null, routes: 1, n: 1, withoutWeight: 1, withoutVolume: 1, unavailableReason: 'no_estimate' });
        });
    });

    describe('load: kg and m³ apart', () => {
        it('takes the kg peak and the m³ peak from different routes, each against its own capacity, and does not cap an overload', async () => {
            const load = vehicle((await get('supervisor', { ...period, vehicleId: ids.busy })).body, ids.busy).load;
            // Route A carries 500 kg / 1.5 m³; route B 50 kg / 6 m³ on a 1000 kg / 5 m³ vehicle.
            expect(load).toMatchObject({ routes: 2, n: 3, withoutWeight: 0, withoutVolume: 0, unavailableReason: null });
            expect(load.kg).toEqual({ used: 500, capacity: 1000, ratio: 0.5 });
            expect(load.m3).toEqual({ used: 6, capacity: 5, ratio: 1.2 });
        });

        it('states its units: calendar days for time, kg and m³ for load, and no figure in hours anywhere', async () => {
            const res = await get('supervisor', period);
            expect(res.body.units).toEqual({ time: 'calendar_days', load: ['kg', 'm3'] });
            expect(keysOf(res.body).filter((key) => /hour/i.test(key))).toEqual([]);
        });
    });

    describe('maintenance in Bolivia calendar days, clipped to the period', () => {
        it('counts an open maintenance through the end of the period, from its Bolivia start day', async () => {
            expect(vehicle((await get('supervisor', { ...period, vehicleId: ids.busy })).body, ids.busy).maintenance)
                .toEqual({ count: 1, calendarDays: 4, overlapsDetected: false });
        });

        it('clips a maintenance that started before the period, counts a same-day one as 1 day and leaves out one that ended before', async () => {
            expect(vehicle((await get('supervisor', { ...period, vehicleId: ids.unestimated })).body, ids.unestimated).maintenance)
                .toEqual({ count: 2, calendarDays: 4, overlapsDetected: false });
        });

        it('without from/to the period is the cut-off day', async () => {
            const res = await get('supervisor', { cutoff: '2024-02-08', vehicleId: ids.busy });
            expect(res.body).toMatchObject({ from: '2024-02-08', to: '2024-02-08' });
            expect(vehicle(res.body, ids.busy).maintenance).toEqual({ count: 1, calendarDays: 1, overlapsDetected: false });
        });

        it('a past cut-off keeps the maintenance and load of the period but answers the availability and the status as N/D', async () => {
            const res = await get('supervisor', period);
            expect(res.body.cutoff).toEqual({ date: TO, kind: 'past' });
            expect(res.body.availability).toEqual({ assignable: null, registered: null, inMaintenance: null, outOfService: null, unavailableReason: 'no_status_history' });
            const busy = vehicle(res.body, ids.busy);
            expect(busy.fleetStatus).toBeNull();
            expect(busy.maintenance.calendarDays).toBe(4);
            expect(busy.load.kg.used).toBe(500);
        });

        it('a status filter cannot be answered for a past cut-off: empty list, n = 0', async () => {
            const res = await get('supervisor', { ...period, fleetStatus: 'active' });
            expect(res.body).toMatchObject({ n: 0, vehicles: [] });
        });

        it('today\'s cut-off gives the current status of the vehicle', async () => {
            const res = await get('supervisor', { vehicleId: ids.empty });
            expect(res.body.cutoff.kind).toBe('current');
            expect(res.body.availability).toMatchObject({ assignable: 1, registered: 1, inMaintenance: 0, outOfService: 0, unavailableReason: null });
            expect(vehicle(res.body, ids.empty).fleetStatus).toBe('active');
        });
    });

    describe('driver detail and privacy', () => {
        it('gives the supervisor each driver with deliveries and attempts by hand count, a small sample (n = 1) included', async () => {
            const productivity = (await get('supervisor', period)).body.productivity;
            expect(productivity).toMatchObject({ detailRestricted: false, deliveredCount: 3, attemptCount: 4 });
            expect(productivity.drivers).toEqual(expect.arrayContaining([
                { driverId: ids.first, driverName: names.first, deliveredCount: 2, attemptCount: 3 },
                { driverId: ids.second, driverName: names.second, deliveredCount: 1, attemptCount: 1 },
            ]));
            expect(productivity.drivers).toHaveLength(2);
        });

        it('lets the supervisor narrow to one driver', async () => {
            const productivity = (await get('supervisor', { ...period, driverId: ids.second })).body.productivity;
            expect(productivity).toEqual({
                detailRestricted: false, deliveredCount: 1, attemptCount: 1,
                drivers: [{ driverId: ids.second, driverName: names.second, deliveredCount: 1, attemptCount: 1 }],
            });
        });

        it('gives the coordinator only the fleet aggregate, with no driver id or name anywhere in the answer', async () => {
            const res = await get('coordinator', period);
            expect(res.status).toBe(200);
            expect(res.body.productivity).toEqual({ detailRestricted: true, deliveredCount: 3, attemptCount: 4, drivers: [] });
            const text = JSON.stringify(res.body);
            for (const leak of [names.first, names.second]) expect(text).not.toContain(leak);
            expect(keysOf(res.body)).not.toContain('driverId');
            expect(keysOf(res.body)).not.toContain('driverName');
        });

        it('does not let the coordinator rebuild one driver\'s figures by narrowing to a vehicle', async () => {
            // Narrowed to vehicle B the figures change (the first driver also drove vehicle O): the supervisor gets the
            // narrowed detail, while the coordinator keeps the fleet-wide aggregate, so the filter tells him nothing.
            const supervisor = (await get('supervisor', { ...period, vehicleId: ids.busy })).body.productivity;
            expect(supervisor).toMatchObject({ deliveredCount: 2, attemptCount: 3 });
            expect(supervisor.drivers).toEqual(expect.arrayContaining([
                { driverId: ids.first, driverName: names.first, deliveredCount: 1, attemptCount: 2 },
                { driverId: ids.second, driverName: names.second, deliveredCount: 1, attemptCount: 1 },
            ]));
            const coordinator = (await get('coordinator', { ...period, vehicleId: ids.busy })).body.productivity;
            expect(coordinator).toEqual({ detailRestricted: true, deliveredCount: 3, attemptCount: 4, drivers: [] });
        });

        it('refuses the driver filter to the coordinator before querying anything', async () => {
            const res = await get('coordinator', { ...period, driverId: ids.first });
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('DRIVER_DETAIL_FORBIDDEN');
            expect(JSON.stringify(res.body)).not.toContain(names.first);
        });

        it('denies roles outside the dashboard: admin and driver get 403, no token gets 401, none sees any figure', async () => {
            for (const caller of ['admin', 'driver'] as const) {
                const res = await get(caller, period);
                expect(res.status, caller).toBe(403);
                expect(res.body.error, caller).toBe('INSUFFICIENT_PERMISSIONS');
                expect(res.body.productivity, caller).toBeUndefined();
            }
            const anonymous = await get(null, period);
            expect(anonymous.status).toBe(401);
            expect(anonymous.body.productivity).toBeUndefined();
        });
    });
});
