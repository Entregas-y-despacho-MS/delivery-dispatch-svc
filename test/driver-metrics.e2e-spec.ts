// ST-35.2 — Real HTTP/PostgreSQL acceptance checks for GET /drivers/me/metrics (RF-U09).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { DISPATCH_STATUS_CHANGED_EVENT } from '../src/app/dispatch-status/dispatch-status-changed.event.js';
import { todayInOperatingTimeZone } from '../src/modules/dispatch/dispatches/utils/operating-date.util.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

type Actor = 'driver1' | 'driver2' | 'coordinator';

describe('GET /drivers/me/metrics (e2e, ST-35.2)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const tokens: Record<Actor, string> = { driver1: '', driver2: '', coordinator: '' };
    const users: Record<Actor, number> = { driver1: 0, driver2: 0, coordinator: 0 };
    const statusIds: Record<string, number> = {};
    const batchIds: number[] = [];
    const run = Date.now().toString(36).toUpperCase();
    const prefix = `ST352-${run}`;
    let dispatchSequence = 0;
    let deliveryTypeId: number;

    const get = (actor: Actor | null, period?: string) => {
        const req = request(app.getHttpServer()).get(`/${apiPrefix}/drivers/me/metrics`).query(period === undefined ? {} : { period });
        return actor ? req.set('Authorization', `Bearer ${tokens[actor]}`) : req;
    };

    const newBatch = async (driver: Actor, shiftDate: string): Promise<number> => {
        const [{ route_batch_id: id }] = await dataSource.query(
            `INSERT INTO route_batches (driver_id, shift_date, status) VALUES ($1, $2::date, 'closed') RETURNING route_batch_id`,
            [users[driver], shiftDate],
        );
        batchIds.push(id);
        return id;
    };

    interface DispatchOptions { status: string; closedAt?: Date | null; window?: [Date, Date] | null; score?: number }
    const newDispatch = async (batchId: number, options: DispatchOptions): Promise<number> => {
        const sequence = ++dispatchSequence;
        const ref = `${prefix}-${sequence}`;
        const [{ dispatch_id: id }] = await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order, source_order_ref,
                                     tracking_code, delivery_address, evidence_policy, closed_at,
                                     scheduled_window_start, scheduled_window_end)
             VALUES ($1, $2, $3, $4, $5, $6, 'Dirección E2E ST-35.2', 'hand_delivery_standard', $7, $8, $9) RETURNING dispatch_id`,
            [deliveryTypeId, statusIds[options.status], batchId, sequence, ref, `DSP-2026-${String(90000 + sequence)}`,
                options.closedAt ?? null, options.window?.[0] ?? null, options.window?.[1] ?? null],
        );
        if (options.score !== undefined) await dataSource.query(`INSERT INTO dispatch_ratings (dispatch_id, score) VALUES ($1, $2)`, [id, options.score]);
        return id;
    };

    const minutes = (from: Date, offset: number) => new Date(from.getTime() + offset * 60_000);

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        apiPrefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(apiPrefix);
        app.useGlobalPipes(new ValidationPipe({
            transform: true, whitelist: true, forbidNonWhitelisted: true,
            transformOptions: { enableImplicitConversion: false },
        }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        dataSource = moduleRef.get(DataSource);

        const passwordHash = await hashPassword('E2eTest1234');
        for (const actor of ['driver1', 'driver2', 'coordinator'] as const) {
            const [{ role_id: roleId }] = await dataSource.query(`SELECT role_id FROM roles WHERE name = $1`, [actor === 'coordinator' ? 'coordinator' : 'driver']);
            const [{ user_id: userId }] = await dataSource.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change)
                 VALUES ($1, $2, $3, $4, false) RETURNING user_id`,
                [roleId, `ST-35.2 ${actor} ${run}`, `e2e_st352_${actor}_${run}`, passwordHash],
            );
            users[actor] = userId;
            const login = await request(app.getHttpServer()).post(`/${apiPrefix}/auth/login`).send({ username: `e2e_st352_${actor}_${run}`, password: 'E2eTest1234' });
            expect(login.status, `login ${actor}`).toBe(200);
            tokens[actor] = login.body.accessToken as string;
        }

        for (const row of await dataSource.query(`SELECT dispatch_status_id, name FROM dispatch_statuses`)) statusIds[row.name] = row.dispatch_status_id;
        [{ dispatch_type_id: deliveryTypeId }] = await dataSource.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);

        // driver1, route of today: 3 delivered (2 inside their window, 1 late; ratings 5 and 4), 1 not delivered, 1 still on its way.
        const now = new Date();
        const today = await newBatch('driver1', todayInOperatingTimeZone(now));
        await newDispatch(today, { status: 'delivered', closedAt: now, window: [minutes(now, -30), minutes(now, 30)], score: 5 });
        await newDispatch(today, { status: 'delivered', closedAt: now, window: [minutes(now, -30), minutes(now, 30)], score: 4 });
        await newDispatch(today, { status: 'delivered', closedAt: now, window: [minutes(now, -120), minutes(now, -60)] });
        await newDispatch(today, { status: 'not_delivered', closedAt: now, window: [minutes(now, -30), minutes(now, 30)] });
        await newDispatch(today, { status: 'out_for_delivery', window: [minutes(now, -30), minutes(now, 30)] });
        // An old route (60 days ago) must not count in any period, even the month.
        const old = await newBatch('driver1', todayInOperatingTimeZone(minutes(now, -60 * 24 * 60)));
        await newDispatch(old, { status: 'delivered', closedAt: minutes(now, -60 * 24 * 60), window: [minutes(now, -60 * 24 * 60 - 30), minutes(now, -60 * 24 * 60 + 30)], score: 1 });
        // driver2 delivered one today, so isolation is checked in both directions.
        const other = await newBatch('driver2', todayInOperatingTimeZone(now));
        await newDispatch(other, { status: 'delivered', closedAt: now, window: [minutes(now, -30), minutes(now, 30)], score: 2 });
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) {
            await withEventPurge(dataSource, { dispatchRefs: [`${prefix}%`], routeBatchIds: batchIds, userNames: [`e2e_st352_%_${run}`] }, async (manager) => {
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${prefix}%`]);
                if (batchIds.length) await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
                await manager.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_st352_%_${run}`]);
            });
        }
        await app?.close();
    });

    it('calcula las métricas de hoy con SQL: entregas, % a tiempo, asignados y calificación', async () => {
        const response = await get('driver1', 'today');

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            period: 'today', deliveredCount: 3, onTimePercentage: 66.7, assignedCount: 5, rating: 4.5, ratingsCount: 2,
        });
        expect(response.body.from).toBe(todayInOperatingTimeZone());
        expect(response.body.to).toBe(todayInOperatingTimeZone());
    });

    it('la semana y el mes no cuentan la ruta de hace 60 días', async () => {
        for (const period of ['week', 'month']) {
            const response = await get('driver1', period);
            expect(response.status, period).toBe(200);
            expect(response.body, period).toMatchObject({ deliveredCount: 3, assignedCount: 5, ratingsCount: 2, rating: 4.5 });
        }
    });

    it('aísla a los repartidores: cada uno ve solo lo suyo', async () => {
        const response = await get('driver2', 'today');

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ deliveredCount: 1, onTimePercentage: 100, assignedCount: 1, rating: 2, ratingsCount: 1 });
    });

    it('un repartidor sin historial recibe ceros y rating null', async () => {
        await dataSource.query(`DELETE FROM dispatch_ratings WHERE dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE route_batch_id IN (SELECT route_batch_id FROM route_batches WHERE driver_id = $1))`, [users.driver2]);
        await dataSource.query(`DELETE FROM dispatches WHERE route_batch_id IN (SELECT route_batch_id FROM route_batches WHERE driver_id = $1)`, [users.driver2]);
        await dataSource.query(`DELETE FROM route_batches WHERE driver_id = $1`, [users.driver2]);
        const emitter = app.get(EventEmitter2);
        emitter.emit(DISPATCH_STATUS_CHANGED_EVENT, { dispatchId: 0, status: 'delivered', previousStatus: 'in_transit', version: 1, updatedAt: new Date().toISOString() });

        const response = await get('driver2', 'month');

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ deliveredCount: 0, onTimePercentage: 0, assignedCount: 0, rating: null, ratingsCount: 0 });
    });

    it('sirve la segunda consulta desde la caché y la invalida al confirmarse una entrega', async () => {
        const first = await get('driver1', 'today');
        const [{ route_batch_id: batchId, dispatch_id: dispatchId }] = await dataSource.query(
            `SELECT rb.route_batch_id, d.dispatch_id FROM dispatches d JOIN route_batches rb USING (route_batch_id)
              WHERE rb.driver_id = $1 AND d.source_order_ref LIKE $2 ORDER BY d.dispatch_id LIMIT 1`,
            [users.driver1, `${prefix}%`],
        );
        expect(batchId).toBeDefined();
        // A new delivery written straight to the database is not visible while the answer is cached...
        const now = new Date();
        await newDispatch(batchId, { status: 'delivered', closedAt: now, window: [minutes(now, -30), minutes(now, 30)] });
        const cached = await get('driver1', 'today');
        expect(cached.body.deliveredCount).toBe(first.body.deliveredCount);

        // ...and shows up once the confirmation event drops the driver's keys.
        app.get(EventEmitter2).emit(DISPATCH_STATUS_CHANGED_EVENT, { dispatchId, status: 'delivered', previousStatus: 'in_transit', version: 1, updatedAt: now.toISOString() });
        let fresh = cached;
        for (let attempt = 0; attempt < 20 && fresh.body.deliveredCount === first.body.deliveredCount; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            fresh = await get('driver1', 'today');
        }
        expect(fresh.body.deliveredCount).toBe(first.body.deliveredCount + 1);
    });

    it('rechaza un period ausente o inválido con 400', async () => {
        for (const period of [undefined, 'year', 'TODAY', '']) {
            const response = await get('driver1', period);
            expect(response.status, String(period)).toBe(400);
            expect(response.body.message).toContain("The 'period' parameter must be one of: today, week, month.");
        }
    });

    it('exige token y rol de repartidor', async () => {
        expect((await get(null, 'today')).status).toBe(401);
        expect((await get('coordinator', 'today')).status).toBe(403);
    });
});
