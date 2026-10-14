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
import { withEventPurge } from './helpers/purge-append-only-events.js';

describe('Mi Jornada del repartidor (e2e, RF-U02)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const tokens: Record<string, string> = {};
    const userIds: Record<string, number> = {};
    const statusId: Record<string, number> = {};
    const typeId: Record<string, number> = {};

    const run = Date.now().toString(36).toUpperCase();
    const DAY = '2031-05-20';
    const OTHER_DAY = '2031-05-21';
    const url = (query = '') => `/${apiPrefix}/dispatches/my-assignments${query}`;
    const get = (role: string, query = '') => request(app.getHttpServer()).get(url(query)).set({ Authorization: `Bearer ${tokens[role]}` });

    const newBatch = async (driver: string, date: string, status = 'confirmed', acceptedAt: string | null = null) =>
        (await dataSource.query(
            `INSERT INTO route_batches (driver_id, shift_date, status, accepted_at) VALUES ($1, $2, $3, $4) RETURNING route_batch_id`,
            [userIds[driver], date, status, acceptedAt],
        ))[0].route_batch_id as number;
    const newStop = async (
        batchId: number, seq: number | null, status: string, ref: string,
        over: { lat?: string | null; trackingCode?: string | null; evidencePolicy?: string; reference?: string | null; type?: string } = {},
    ) =>
        (await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order, source_order_ref, delivery_address, delivery_latitude, delivery_longitude, estimated_weight_kg,
                                     tracking_code, evidence_policy, delivery_reference)
             VALUES ($6, $1, $2, $3, $4, 'Av. Test 123', $5, '-68.150000', 12.5, $7, $8, $9) RETURNING dispatch_id`,
            [
                statusId[status], batchId, seq, `asg-${run}-${ref}`, over.lat === undefined ? '-16.500000' : over.lat,
                typeId[over.type ?? 'delivery'], over.trackingCode ?? null, over.evidencePolicy ?? 'hand_delivery_standard', over.reference ?? null,
            ],
        ))[0].dispatch_id as number;
    const newPackage = async (dispatchId: number, externalId: string, l: number, w: number, h: number, kg: number) =>
        (await dataSource.query(
            `INSERT INTO dispatch_packages (dispatch_id, external_package_id, length_cm, width_cm, height_cm, gross_weight_kg) VALUES ($1, $2, $3, $4, $5, $6) RETURNING dispatch_package_id`,
            [dispatchId, `${externalId}-${run}`, l, w, h, kg],
        ))[0].dispatch_package_id as number;

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
        for (const row of await dataSource.query(`SELECT dispatch_type_id, name FROM dispatch_types`)) typeId[row.name] = row.dispatch_type_id;
    });

    afterAll(async () => {
        await withEventPurge(dataSource, { dispatchRefs: [`asg-${run}-%`], routeBatchIds: batches, userNames: [`e2e_asg_%_${run}`] }, async (manager) => {
            await manager.query(`DELETE FROM dispatch_packages WHERE dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE source_order_ref LIKE $1)`, [`asg-${run}-%`]);
            await manager.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`asg-${run}-%`]);
            if (batches.length) await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1)`, [batches]);
            await manager.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_asg_%_${run}`]);
        });
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

    describe('contrato completo (ST-49.5)', () => {
        const CONTRACT_DAY = '2031-06-10';
        const stopRef = (ref: string) => `asg-${run}-${ref}`;
        const find = (body: any, ref: string) => body.data.find((s: any) => s.sourceOrderRef === stopRef(ref));
        const code = `DSP-2031-${run.slice(-5).padStart(5, '0')}`;

        // Un repartidor tiene a lo sumo un lote por día (uq_route_batches_driver_shift_date): un día por estado.
        it.each([
            ['confirmed', '2031-08-01', 'scheduled', true],
            ['in_execution', '2031-08-02', 'out_for_delivery', true],
            ['provisional', '2031-08-03', 'in_planning', false],
            ['pending_final_review', '2031-08-04', 'in_planning', false],
        ])('lote %s (%s): ¿se devuelve? %s', async (batchStatus, day, stopStatus, visible) => {
            const batch = await newBatch('driver1', day as string, batchStatus as string);
            batches.push(batch);
            await newStop(batch, 1, stopStatus as string, `V-${batchStatus}`);

            const res = await get('driver1', `?date=${day}`);

            expect(res.status).toBe(200);
            if (visible) {
                expect(res.body.data.map((s: any) => s.sourceOrderRef)).toEqual([stopRef(`V-${batchStatus}`)]);
                expect(res.body.data[0].routeBatch.status).toBe(batchStatus);
            } else {
                expect(res.body).toEqual({ date: day, lastModifiedAt: null, data: [] });
            }
        });

        it('expone trackingCode, política de evidencia, tipo de despacho, referencia y datos del lote', async () => {
            const batch = await newBatch('driver3', CONTRACT_DAY, 'confirmed', '2031-06-10T12:00:00.000Z');
            batches.push(batch);
            await newStop(batch, 1, 'scheduled', 'F-FULL', { trackingCode: code, evidencePolicy: 'high_value_control', reference: 'Edificio azul', type: 'warehouse_return_pickup' });
            const plainBatch = await newBatch('driver2', CONTRACT_DAY, 'confirmed');
            batches.push(plainBatch);
            await newStop(plainBatch, 1, 'scheduled', 'F-DEFAULT');

            const full = find((await get('driver3', `?date=${CONTRACT_DAY}`)).body, 'F-FULL');
            const plain = find((await get('driver2', `?date=${CONTRACT_DAY}`)).body, 'F-DEFAULT');

            expect(full.trackingCode).toBe(code);
            expect(full.evidencePolicy).toBe('high_value_control');
            expect(full.deliveryReference).toBe('Edificio azul');
            expect(full.dispatchType).toEqual({ id: typeId.warehouse_return_pickup, name: 'warehouse_return_pickup' });
            expect(full.routeBatch).toEqual({ id: batch, status: 'confirmed', acceptedAt: '2031-06-10T12:00:00.000Z' });
            expect(plain.trackingCode).toBeNull();
            expect(plain.evidencePolicy).toBe('hand_delivery_standard');
            expect(plain.deliveryReference).toBeNull();
            expect(plain.dispatchType.name).toBe('delivery');
            expect(plain.routeBatch.acceptedAt).toBeNull();
        });

        it.each(['hand_delivery_standard', 'contactless_delivery', 'high_value_control'])('devuelve la política de evidencia %s tal cual', async (policy) => {
            const day = `2031-07-${10 + ['hand_delivery_standard', 'contactless_delivery', 'high_value_control'].indexOf(policy)}`;
            const batch = await newBatch('driver1', day, 'confirmed');
            batches.push(batch);
            await newStop(batch, 1, 'scheduled', `E-${policy}`, { evidencePolicy: policy });

            const { body } = await get('driver1', `?date=${day}`);
            expect(body.data[0].evidencePolicy).toBe(policy);
        });

        it('devuelve los bultos con packageId, medidas y peso como número, ordenados; sin bultos → []', async () => {
            const batch = await newBatch('driver1', '2031-06-12', 'confirmed');
            batches.push(batch);
            const withPackages = await newStop(batch, 1, 'scheduled', 'K-PKGS');
            await newStop(batch, 2, 'scheduled', 'K-NONE');
            const first = await newPackage(withPackages, 'PKG-A', 40, 30, 25.5, 6.5);
            const second = await newPackage(withPackages, 'PKG-B', 10, 10, 10, 1.25);

            const { body } = await get('driver1', '?date=2031-06-12');
            const pkgs = find(body, 'K-PKGS').packages;

            expect(body.data).toHaveLength(2);
            expect(pkgs).toEqual([
                { packageId: first, externalPackageId: `PKG-A-${run}`, lengthCm: 40, widthCm: 30, heightCm: 25.5, grossWeightKg: 6.5 },
                { packageId: second, externalPackageId: `PKG-B-${run}`, lengthCm: 10, widthCm: 10, heightCm: 10, grossWeightKg: 1.25 },
            ]);
            expect(pkgs[0]).not.toHaveProperty('id');
            expect(find(body, 'K-NONE').packages).toEqual([]);
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
