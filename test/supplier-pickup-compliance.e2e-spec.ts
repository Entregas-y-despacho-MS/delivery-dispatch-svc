// ST-305.1 — Real HTTP/PostgreSQL acceptance checks for GET /reports/supplier-pickups (ES-305, Dashboard 5, section 5A).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { todayInOperatingTimeZone } from '../src/modules/dispatch/dispatches/utils/operating-date.util.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

type Actor = 'coordinator' | 'supervisor' | 'driver';
type Query = Record<string, string | number | undefined>;

interface Seed {
    n: number;
    supplier: 'A' | 'B' | 'C';
    warehouse: 'W1' | 'W2';
    status: string;
    /** [start, end] of the window in force; null = no window. */
    window: [string, string] | null;
    custodyAt?: string;
    arrivedAt?: string;
    createdAt?: string;
}

// March 2020: the past, so every appointment has expired and no other suite writes there. Bolivia is UTC-4: 14:00-16:00 there is 18:00Z-20:00Z.
const win = (day: string): [string, string] => [`2020-03-${day}T18:00:00Z`, `2020-03-${day}T20:00:00Z`];
const MARCH = { from: '2020-03-01', to: '2020-03-31' };
const HOUR = 3_600_000;

describe('GET /reports/supplier-pickups (e2e, ST-305.1)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const tokens: Record<Actor, string> = { coordinator: '', supervisor: '', driver: '' };
    const run = Date.now().toString(36).toUpperCase();
    const prefix = `ST3051-${run}`;
    const supplierId = (key: 'A' | 'B' | 'C') => `SUP-${run}-${key}`;
    const ids = { warehouse: {} as Record<'W1' | 'W2', number>, dispatch: {} as Record<number, number> };
    const statusIds: Record<string, number> = {};
    let pickupTypeId = 0;

    const get = (actor: Actor | null, query: Query) => {
        const req = request(app.getHttpServer()).get(`/${apiPrefix}/reports/supplier-pickups`).query(query);
        return actor ? req.set('Authorization', `Bearer ${tokens[actor]}`) : req;
    };
    const report = (query: Query) => get('coordinator', query);
    const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
    const bolivianDay = (offsetDays: number) => new Date(Date.parse(`${todayInOperatingTimeZone()}T00:00:00Z`) + offsetDays * 86_400_000).toISOString().slice(0, 10);

    const insertPickup = async (seed: Seed): Promise<number> => {
        const [{ dispatch_id: id }] = await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, destination_warehouse_id, source_order_ref, delivery_address,
                                     scheduled_window_start, scheduled_window_end, custody_received_at, arrived_at_warehouse_at, created_at)
             VALUES ($1, $2, $3, $4, 'Planta proveedor E2E ST-305.1', $5, $6, $7, $8, COALESCE($9::timestamptz, NOW())) RETURNING dispatch_id`,
            [
                pickupTypeId, statusIds[seed.status], ids.warehouse[seed.warehouse], `${prefix}-${seed.n}`,
                seed.window?.[0] ?? null, seed.window?.[1] ?? null, seed.custodyAt ?? null, seed.arrivedAt ?? null, seed.createdAt ?? null,
            ],
        );
        ids.dispatch[seed.n] = id;
        await dataSource.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, metadata) VALUES ($1, 'created', $2::jsonb)`,
            [id, JSON.stringify({ source: 'procurement', supplier: { supplierId: supplierId(seed.supplier), name: `Proveedor ${seed.supplier}` } })],
        );
        return id;
    };

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
        for (const actor of ['coordinator', 'supervisor', 'driver'] as const) {
            const [{ role_id: roleId }] = await dataSource.query(`SELECT role_id FROM roles WHERE name = $1`, [actor]);
            await dataSource.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false)`,
                [roleId, `ST-305.1 ${actor} ${run}`, `e2e_st3051_${actor}_${run}`, passwordHash],
            );
            const login = await request(app.getHttpServer()).post(`/${apiPrefix}/auth/login`).send({ username: `e2e_st3051_${actor}_${run}`, password: 'E2eTest1234' });
            expect(login.status, `login ${actor}`).toBe(200);
            tokens[actor] = login.body.accessToken as string;
        }

        for (const key of ['W1', 'W2'] as const) {
            const [{ warehouse_id: id }] = await dataSource.query(
                `INSERT INTO warehouses (code, name, address, latitude, longitude, reception_start_time, reception_end_time)
                 VALUES ($1, $2, 'Dirección E2E', -16.5, -68.15, '08:00', '18:00') RETURNING warehouse_id`, [`W3051${run}${key}`, `E2E3051 ${run} ${key}`]);
            ids.warehouse[key] = id;
        }
        for (const row of await dataSource.query(`SELECT dispatch_status_id, name FROM dispatch_statuses`)) statusIds[row.name] = row.dispatch_status_id;
        [{ dispatch_type_id: pickupTypeId }] = await dataSource.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'supplier_pickup'`);
        const [{ reschedule_reason_id: reasonId }] = await dataSource.query(`SELECT reschedule_reason_id FROM reschedule_reasons ORDER BY reschedule_reason_id LIMIT 1`);

        // ── March 2020, supplier A, warehouse W1 unless said otherwise (see the expected figures in each test) ──
        await insertPickup({ n: 1, supplier: 'A', warehouse: 'W1', status: 'delivered', window: win('10'), custodyAt: '2020-03-10T19:00:00Z' });               // on time
        await insertPickup({ n: 2, supplier: 'A', warehouse: 'W1', status: 'delivered', window: win('10'), custodyAt: '2020-03-10T21:00:00Z' });               // late
        await insertPickup({ n: 3, supplier: 'A', warehouse: 'W1', status: 'incident', window: win('12') });                                                   // failed
        await insertPickup({ n: 4, supplier: 'A', warehouse: 'W1', status: 'assigned', window: win('11') });                                                   // expired, open
        await insertPickup({ n: 6, supplier: 'A', warehouse: 'W1', status: 'cancelled', window: win('13') });                                                  // cancelled
        await insertPickup({ n: 7, supplier: 'A', warehouse: 'W1', status: 'assigned', window: null, createdAt: '2020-03-16T15:00:00Z' });                     // no appointment
        await insertPickup({ n: 8, supplier: 'A', warehouse: 'W1', status: 'picked_up_in_transit', window: win('12') });                                        // collected, no timestamp: N/D
        await insertPickup({ n: 9, supplier: 'A', warehouse: 'W1', status: 'delivered', window: win('19'), custodyAt: '2020-03-19T19:00:00Z' });               // rescheduled after the original expired, on time
        await insertPickup({ n: 10, supplier: 'A', warehouse: 'W1', status: 'incident', window: win('26') });                                                  // rescheduled before the original expired, failed
        await insertPickup({ n: 12, supplier: 'A', warehouse: 'W1', status: 'in_transit', window: win('14'), arrivedAt: '2020-03-14T19:00:00Z' });             // arrived at the warehouse, never collected
        await insertPickup({ n: 13, supplier: 'A', warehouse: 'W2', status: 'delivered', window: win('15'), custodyAt: '2020-03-15T21:00:00Z' });               // late, other warehouse
        await insertPickup({ n: 11, supplier: 'B', warehouse: 'W2', status: 'delivered', window: win('10'), custodyAt: '2020-03-10T19:00:00Z' });               // other supplier, on time
        await insertPickup({ n: 14, supplier: 'C', warehouse: 'W1', status: 'delivered', window: win('10') });                                                 // the only one of its supplier, N/D
        for (const [n, previous, next, createdAt] of [
            [9, win('05'), win('19'), '2020-03-06T10:00:00Z'],
            [10, win('20'), win('23'), '2020-03-20T10:00:00Z'],
            [10, win('23'), win('26'), '2020-03-21T10:00:00Z'], // a second move: the original stays the first window (March 20)
        ] as const) {
            await dataSource.query(
                `INSERT INTO dispatch_reschedules (dispatch_id, reschedule_reason_id, rescheduled_by_type, previous_window_start, previous_window_end, new_window_start, new_window_end, created_at)
                 VALUES ($1, $2, 'coordinator', $3, $4, $5, $6, $7)`,
                [ids.dispatch[n], reasonId, previous[0], previous[1], next[0], next[1], createdAt]);
        }

        // ── Around today, supplier A: a future appointment and one just expired, relative to the moment the suite runs ──
        await insertPickup({ n: 20, supplier: 'A', warehouse: 'W1', status: 'scheduled', window: [iso(24 * HOUR), iso(26 * HOUR)] });                          // not expired yet
        await insertPickup({ n: 21, supplier: 'A', warehouse: 'W1', status: 'pickup_scheduled', window: [iso(24 * HOUR), iso(26 * HOUR)], custodyAt: iso(-HOUR) }); // collected early: still not due
        await insertPickup({ n: 22, supplier: 'A', warehouse: 'W1', status: 'assigned', window: [iso(-50 * HOUR), iso(-48 * HOUR)] });                         // expired 2 days ago, open
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) {
            await withEventPurge(dataSource, { dispatchRefs: [`${prefix}%`], routeBatchIds: [], userNames: [`e2e_st3051_%_${run}`] }, async (manager) => {
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${prefix}%`]);
                await manager.query(`DELETE FROM warehouses WHERE code LIKE $1`, [`W3051${run}%`]);
                await manager.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_st3051_%_${run}`]);
            });
        }
        await app?.close();
    });

    describe('compliance of the expired appointments', () => {
        it('separates on time, late, failed and every exception, and shows every figure with the rate', async () => {
            const response = await report({ ...MARCH, supplierId: supplierId('A') });

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({
                ...MARCH,
                dateBasis: 'appointment_window_end',
                timeZone: 'America/La_Paz',
                filters: { supplierId: supplierId('A'), warehouseId: null, zoneId: null, status: null },
                empty: false,
            });
            expect(response.body.counts).toEqual({
                onTime: 2, // 1, 9
                late: 2, // 2, 13
                failed: 2, // 3, 10
                openOverdue: 2, // 4, 12
                pendingNotDue: 0,
                cancelled: 1, // 6
                noValidAppointment: 1, // 7
                unknownTiming: 1, // 8
            });
            // Denominator: on time + late + failed. The open overdue one (4, 12) is not completed and is not in it.
            expect(response.body.metrics).toEqual({ numerator: 2, denominator: 6, n: 6, percentage: 33.3, unavailableReason: null });
        });

        it('lists the actionable exceptions, the most overdue first, with the supplier and without the completed ones', async () => {
            const response = await report({ ...MARCH, supplierId: supplierId('A') });
            expect(response.body.exceptionsTotal).toBe(7);
            expect(response.body.exceptions.map((e: { dispatchId: number }) => e.dispatchId)).toEqual(
                [2, 4, 3, 8, 12, 13, 10].map((n) => ids.dispatch[n]),
            );
            expect(response.body.exceptions.map((e: { category: string }) => e.category)).toEqual(['late', 'openOverdue', 'failed', 'unknownTiming', 'openOverdue', 'late', 'failed']);
            expect(response.body.exceptions[0]).toMatchObject({
                status: 'delivered',
                purchaseOrderRef: `${prefix}-2`,
                supplier: { id: supplierId('A'), name: 'Proveedor A' },
                destinationWarehouseId: ids.warehouse.W1,
                window: { start: '2020-03-10T18:00:00.000Z', end: '2020-03-10T20:00:00.000Z' },
                originalWindow: null,
                custodyReceivedAt: '2020-03-10T21:00:00.000Z',
            });
        });

        it('shows the arrival at the warehouse apart: an arrived pickup that was never collected is still an open overdue exception', async () => {
            const response = await report({ ...MARCH, supplierId: supplierId('A') });
            const arrived = response.body.exceptions.find((e: { dispatchId: number }) => e.dispatchId === ids.dispatch[12]);
            expect(arrived).toMatchObject({ category: 'openOverdue', arrivedAtWarehouseAt: '2020-03-14T19:00:00.000Z', custodyReceivedAt: null });
        });

        it('measures a rescheduled pickup against the window in force and keeps the original for audit', async () => {
            const response = await report({ ...MARCH, supplierId: supplierId('A') });
            // 9 was rescheduled on March 6, after its original window (March 5) ended; 10 on March 20 at 10:00Z, before its original ended at 20:00Z.
            expect(response.body.rescheduledCount).toBe(2);
            expect(response.body.originalExpiredBeforeRescheduleCount).toBe(1);
            const failed = response.body.exceptions.find((e: { dispatchId: number }) => e.dispatchId === ids.dispatch[10]);
            expect(failed).toMatchObject({
                category: 'failed',
                window: { start: '2020-03-26T18:00:00.000Z', end: '2020-03-26T20:00:00.000Z' },
                originalWindow: { start: '2020-03-20T18:00:00.000Z', end: '2020-03-20T20:00:00.000Z' },
                rescheduledAt: '2020-03-20T10:00:00.000Z',
            });
        });

        it('cuts the list but reports the real total', async () => {
            const response = await report({ ...MARCH, supplierId: supplierId('A'), exceptionLimit: 2 });
            expect(response.body.exceptions).toHaveLength(2);
            expect(response.body.exceptionsTotal).toBe(7);
        });
    });

    describe('what is not measured', () => {
        it('leaves a future appointment out of the rate and shows it as pending, even if it was collected early', async () => {
            const response = await report({ from: bolivianDay(-3), to: bolivianDay(3), supplierId: supplierId('A') });
            expect(response.status).toBe(200);
            expect(response.body.counts).toMatchObject({ pendingNotDue: 2, openOverdue: 1, onTime: 0, late: 0, failed: 0 });
            expect(response.body.metrics).toMatchObject({ numerator: 0, denominator: 0, percentage: null, unavailableReason: 'no_valid_results' });
            expect(response.body.exceptions.map((e: { dispatchId: number }) => e.dispatchId)).toEqual([ids.dispatch[22]]);
        });

        it('answers N/D with the cause when the only expired pickup says it was collected but has no custody time', async () => {
            const response = await report({ ...MARCH, supplierId: supplierId('C') });
            expect(response.body.counts.unknownTiming).toBe(1);
            expect(response.body.metrics).toEqual({ numerator: 0, denominator: 0, n: 0, percentage: null, unavailableReason: 'missing_timestamp' });
            expect(response.body.empty).toBe(false);
        });

        it('answers "Sin datos" when nothing matches', async () => {
            const response = await report({ ...MARCH, supplierId: `NONE-${run}` });
            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ empty: true, exceptions: [], exceptionsTotal: 0 });
            expect(response.body.metrics).toMatchObject({ percentage: null, denominator: 0, unavailableReason: 'no_valid_results' });
        });

        it('places a pickup without a valid window by its creation, so it does not disappear', async () => {
            const inRange = await report({ from: '2020-03-16', to: '2020-03-16', supplierId: supplierId('A') });
            expect(inRange.body.counts.noValidAppointment).toBe(1);
            const outOfRange = await report({ from: '2020-03-17', to: '2020-03-17', supplierId: supplierId('A') });
            expect(outOfRange.body.counts.noValidAppointment).toBe(0);
        });
    });

    describe('filters', () => {
        it('filters by supplier', async () => {
            const response = await report({ ...MARCH, supplierId: supplierId('B') });
            expect(response.body.metrics).toEqual({ numerator: 1, denominator: 1, n: 1, percentage: 100, unavailableReason: null });
        });

        it('filters by destination warehouse', async () => {
            const response = await report({ ...MARCH, supplierId: supplierId('A'), warehouseId: ids.warehouse.W2 });
            expect(response.body.counts).toMatchObject({ late: 1, onTime: 0 });
            expect(response.body.metrics).toMatchObject({ numerator: 0, denominator: 1, percentage: 0 });
        });

        it('filters by current status', async () => {
            const response = await report({ ...MARCH, supplierId: supplierId('A'), status: 'incident' });
            expect(response.body.counts).toMatchObject({ failed: 2, onTime: 0, late: 0 });
        });

        it('filters by zone (supplier pickups usually carry none, so nothing matches)', async () => {
            const response = await report({ ...MARCH, supplierId: supplierId('A'), zoneId: 2_147_483_647 });
            expect(response.body.empty).toBe(true);
        });

        it('filters by the date of the appointment, both days included', async () => {
            const response = await report({ from: '2020-03-10', to: '2020-03-10', supplierId: supplierId('A') });
            expect(response.body.counts).toMatchObject({ onTime: 1, late: 1, failed: 0, openOverdue: 0 });
        });
    });

    describe('validation and permissions', () => {
        it('rejects a missing date, an inverted or too long range and a list size out of range', async () => {
            expect((await report({ to: '2020-03-31' })).status).toBe(400);
            const inverted = await report({ from: '2020-03-31', to: '2020-03-01' });
            expect(inverted.status).toBe(400);
            expect(inverted.body.error).toBe('INVALID_DATE_RANGE');
            const tooLong = await report({ from: '2018-01-01', to: '2020-03-31' });
            expect(tooLong.status).toBe(400);
            expect(tooLong.body.error).toBe('DATE_RANGE_TOO_LARGE');
            expect((await report({ ...MARCH, exceptionLimit: 101 })).status).toBe(400);
        });

        it('is for the coordinator only: 401 without a token, 403 for the supervisor and the driver', async () => {
            expect((await get(null, MARCH)).status).toBe(401);
            expect((await get('supervisor', MARCH)).status).toBe(403);
            expect((await get('driver', MARCH)).status).toBe(403);
        });
    });
});
