// RF-U02 (ST-28.4) — Pruebas de integración de "Mi Jornada": GET /dispatches/my-assignments.
// Solo el repartidor, y solo ve SU ruta del día, en orden de parada; sin ruta → lista vacía.
//
// Levanta el AppModule real contra una base de datos real y pega por HTTP con supertest. Seguro de
// re-correr contra una base compartida: todo lo creado usa un tag único por corrida y se borra en
// afterAll. Las rutas de prueba usan fechas lejanas (2031) para no mezclarse con datos reales.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { todayInOperatingTimeZone } from '../src/modules/dispatch/dispatches/utils/operating-date.util.js';

describe('Mi Jornada del repartidor (e2e, RF-U02)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const tokens: Record<string, string> = {};
    const userIds: Record<string, number> = {};
    const statusId: Record<string, number> = {};

    const run = Date.now().toString(36).toUpperCase();
    const DAY = '2031-05-20';
    const OTHER_DAY = '2031-05-21';
    const url = (query = '') => `/${apiPrefix}/dispatches/my-assignments${query}`;
    const get = (role: string, query = '') => request(app.getHttpServer()).get(url(query)).set({ Authorization: `Bearer ${tokens[role]}` });

    const newBatch = async (driver: string, date: string) =>
        (await dataSource.query(`INSERT INTO route_batches (driver_id, shift_date) VALUES ($1, $2) RETURNING route_batch_id`, [userIds[driver], date]))[0].route_batch_id as number;
    const newStop = async (batchId: number, seq: number | null, status: string, ref: string, over: { lat?: string | null } = {}) =>
        (await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order, source_order_ref, delivery_address, delivery_latitude, delivery_longitude, estimated_weight_kg)
             VALUES (1, $1, $2, $3, $4, 'Av. Test 123', $5, '-68.150000', 12.5) RETURNING dispatch_id`,
            [statusId[status], batchId, seq, `asg-${run}-${ref}`, over.lat === undefined ? '-16.500000' : over.lat],
        ))[0].dispatch_id as number;

    let batches: number[] = [];

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
        for (const role of ['driver1', 'driver2', 'driver3', 'coordinator', 'admin', 'supervisor']) {
            const roleName = role.startsWith('driver') ? 'driver' : role;
            const [{ role_id }] = await dataSource.query(`SELECT role_id FROM roles WHERE name = $1`, [roleName]);
            const [{ user_id }] = await dataSource.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false) RETURNING user_id`,
                [role_id, `E2E ${role}`, `e2e_asg_${role}_${run}`, passwordHash],
            );
            userIds[role] = user_id;
            const res = await request(app.getHttpServer()).post(`/${apiPrefix}/auth/login`).send({ username: `e2e_asg_${role}_${run}`, password: 'E2eTest1234' });
            tokens[role] = res.body.accessToken as string;
        }
        for (const row of await dataSource.query(`SELECT dispatch_status_id, name FROM dispatch_statuses`)) statusId[row.name] = row.dispatch_status_id;
    });

    afterAll(async () => {
        await dataSource.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`asg-${run}-%`]);
        if (batches.length) await dataSource.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1)`, [batches]);
        await dataSource.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_asg_%_${run}`]);
        await app.close();
    });

    describe('permisos: solo el repartidor', () => {
        it('sin token → 401', async () => {
            expect((await request(app.getHttpServer()).get(url())).status).toBe(401);
        });
        it.each(['coordinator', 'admin', 'supervisor'])('%s → 403', async (role) => {
            const res = await get(role);
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('INSUFFICIENT_PERMISSIONS');
        });
    });

    describe('la ruta del día', () => {
        it('devuelve SOLO las paradas de su ruta de ese día, en orden de parada y con las sin número al final', async () => {
            const mine = await newBatch('driver1', DAY);
            const otherDay = await newBatch('driver1', OTHER_DAY);
            const others = await newBatch('driver2', DAY);
            batches.push(mine, otherDay, others);
            await newStop(mine, 2, 'in_transit', 'B');
            await newStop(mine, 1, 'pending', 'A');
            await newStop(mine, null, 'delivered', 'Z');
            await newStop(otherDay, 1, 'pending', 'OTRO-DIA');
            await newStop(others, 1, 'pending', 'OTRO-REPARTIDOR');

            const res = await get('driver1', `?date=${DAY}`);

            expect(res.status).toBe(200);
            expect(res.body.date).toBe(DAY);
            expect(res.body.data.map((s: any) => s.sourceOrderRef)).toEqual([`asg-${run}-A`, `asg-${run}-B`, `asg-${run}-Z`]);
            expect(res.body.data.map((s: any) => s.dispatchStatus.name)).toEqual(['pending', 'in_transit', 'delivered']);
        });

        it('devuelve coordenadas y peso como números y no expone campos internos', async () => {
            const batch = await newBatch('driver3', DAY);
            batches.push(batch);
            await newStop(batch, 1, 'pending', 'NUM');
            await newStop(batch, 2, 'pending', 'SINCOORD', { lat: null });

            const { body } = await get('driver3', `?date=${DAY}`);

            expect(body.data[0].deliveryLatitude).toBe(-16.5);
            expect(body.data[0].deliveryLongitude).toBe(-68.15);
            expect(body.data[0].estimatedWeightKg).toBe(12.5);
            expect(body.data[1].deliveryLatitude).toBeNull();
            for (const hidden of ['trackingToken', 'routeBatchId', 'dispatchTypeId']) expect(body.data[0]).not.toHaveProperty(hidden);
        });

        it('lastModifiedAt es el cambio más reciente de las paradas', async () => {
            const { body } = await get('driver1', `?date=${DAY}`);
            const newest = body.data.map((s: any) => s.updatedAt).sort().at(-1);
            expect(body.lastModifiedAt).toBe(newest);
        });

        it('un repartidor sin ruta ese día recibe 200 con lista vacía', async () => {
            const res = await get('driver2', `?date=${OTHER_DAY}`);
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ date: OTHER_DAY, lastModifiedAt: null, data: [] });
        });

        it('sin fecha usa el día actual de La Paz', async () => {
            const res = await get('driver2');
            expect(res.status).toBe(200);
            expect(res.body.date).toBe(todayInOperatingTimeZone());
        });
    });

    describe('validación', () => {
        it.each(['14-10-2026', '2026-02-30', 'hoy'])('la fecha %j → 400', async (bad) => {
            const res = await get('driver1', `?date=${encodeURIComponent(bad)}`);
            expect(res.status).toBe(400);
        });

        it('el repartidor no se elige por parámetro: driverId → 400', async () => {
            const res = await get('driver1', `?driverId=${userIds.driver2}`);
            expect(res.status).toBe(400);
        });
    });
});
