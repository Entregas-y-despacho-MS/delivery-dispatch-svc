// ST-56.2 — GET /dispatches/:id/detail: ficha 360° del despacho (RF-A09).
//
// Levanta el AppModule real contra una base real. Todo lo que crea lleva un prefijo único por corrida y se borra en afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

describe('GET /dispatches/:id/detail (e2e, ST-56.2)', () => {
    let app: INestApplication;
    let db: DataSource;
    let prefix: string;
    const run = Date.now().toString(36).toUpperCase();
    const tag = 'e2e_dd_';
    const tokens: Record<string, string> = {};
    const refs: string[] = [];
    const batchIds: number[] = [];
    const vehicleIds: number[] = [];
    const files: string[] = [];
    const statusIds: Record<string, number> = {};
    let deliveryTypeId: number;
    let activeVehicleStatusId: number;
    let incidentReasonId: number;
    let rescheduleReasonId: number;
    let zoneId: number;
    let uploadsDir: string;
    let driverId: number;
    let coordinatorId: number;

    const http = () => request(app.getHttpServer());
    const api = (path: string) => `/${prefix}${path}`;
    const detail = (id: number | string, key = 'coordinator') => http().get(api(`/dispatches/${id}/detail`)).set({ Authorization: `Bearer ${tokens[key]}` });

    const createUser = async (key: string, role: string): Promise<number> => {
        const username = `${tag}${key}_${run}`;
        const [{ user_id }] = await db.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change, active)
             VALUES ((SELECT role_id FROM roles WHERE name = $1), $2, $3, $4, FALSE, TRUE) RETURNING user_id`,
            [role, `Dd ${key} ${run}`, username, await hashPassword('E2eTest1234')],
        );
        const res = await http().post(api('/auth/login')).send({ username, password: 'E2eTest1234' });
        tokens[key] = res.body.accessToken as string;
        return user_id as number;
    };

    const insertDispatch = async (status: string, batchId: number | null = null): Promise<number> => {
        const ref = `DD-${run}-${refs.length}`;
        refs.push(ref);
        const [{ dispatch_id }] = await db.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order, source_order_ref, delivery_address,
                delivery_latitude, delivery_longitude, contact_name, delivery_zone_id, payment_status_label)
             VALUES ($1, $2, $3, $4, $5, 'Av. e2e 123', -16.500000, -68.150000, 'E2E customer', $6, 'Prepaid') RETURNING dispatch_id`,
            [deliveryTypeId, statusIds[status], batchId, batchId ? 1 : null, ref, zoneId],
        );
        return dispatch_id as number;
    };

    const insertEvent = (dispatchId: number, type: string, createdAt: string, actor: number | null, metadata: object | null, detailText: string | null = null) =>
        db.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, detail, actor_user_id, actor_type, metadata, created_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
            [dispatchId, type, detailText, actor, actor ? 'user' : 'system', metadata ? JSON.stringify(metadata) : null, createdAt],
        );

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        prefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(prefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        db = moduleRef.get(DataSource);
        uploadsDir = join(process.cwd(), process.env.UPLOADS_DIR ?? 'uploads');

        [{ vehicle_status_id: activeVehicleStatusId }] = await db.query(`SELECT vehicle_status_id FROM vehicle_statuses WHERE name = 'active'`);
        [{ dispatch_type_id: deliveryTypeId }] = await db.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);
        for (const s of await db.query(`SELECT dispatch_status_id AS id, name FROM dispatch_statuses`)) statusIds[s.name] = s.id;
        [{ incident_reason_id: incidentReasonId }] = await db.query(`SELECT incident_reason_id FROM incident_reasons ORDER BY incident_reason_id LIMIT 1`);
        [{ reschedule_reason_id: rescheduleReasonId }] = await db.query(`SELECT reschedule_reason_id FROM reschedule_reasons ORDER BY reschedule_reason_id LIMIT 1`);
        [{ delivery_zone_id: zoneId }] = await db.query(
            `INSERT INTO delivery_zones (code, name, estimated_time_min) VALUES ($1, $2, 30) RETURNING delivery_zone_id`,
            [`DD${run}`.slice(0, 20), `Zona dd ${run}`],
        );

        coordinatorId = await createUser('coordinator', 'coordinator');
        await createUser('supervisor', 'supervisor');
        await createUser('admin', 'admin');
        driverId = await createUser('driver', 'driver');
    });

    afterAll(async () => {
        if (db) {
            await withEventPurge(db, { dispatchRefs: refs.map((ref) => `${ref}%`), routeBatchIds: batchIds, userNames: [`${tag}%_${run}`] }, async (manager) => {
                const ids = `(SELECT dispatch_id FROM dispatches WHERE source_order_ref = ANY($1::text[]))`;
                await manager.query(`DELETE FROM delivery_evidences WHERE dispatch_id IN ${ids}`, [refs]);
                await manager.query(`DELETE FROM dispatch_incidents WHERE dispatch_id IN ${ids}`, [refs]);
                await manager.query(`DELETE FROM dispatch_reschedules WHERE dispatch_id IN ${ids}`, [refs]);
                await manager.query(`DELETE FROM dispatch_packages WHERE dispatch_id IN ${ids}`, [refs]);
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref = ANY($1::text[])`, [refs]);
                await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
                await manager.query(`DELETE FROM vehicles WHERE vehicle_id = ANY($1::int[])`, [vehicleIds]);
                await manager.query(`DELETE FROM delivery_zones WHERE delivery_zone_id = $1`, [zoneId]);
                await manager.query(`DELETE FROM users WHERE username LIKE $1`, [`${tag}%_${run}`]);
            });
        }
        for (const f of files) await rm(f, { force: true });
        await app?.close();
    });

    describe('despacho completo', () => {
        let dispatchId: number;
        let photoFile: string;
        let sigId: string;

        beforeAll(async () => {
            const [{ vehicle_id }] = await db.query(
                `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3)
                 VALUES ($1, 'van', 'Hiace e2e', $2, 100, 10) RETURNING vehicle_id`,
                [activeVehicleStatusId, `D${run.slice(-6)}`],
            );
            vehicleIds.push(vehicle_id);
            const [{ route_batch_id }] = await db.query(
                `INSERT INTO route_batches (status, shift_date, driver_id, vehicle_id, delivery_zone_id, version)
                 VALUES ('in_execution', '2040-01-01', $1, $2, $3, 0) RETURNING route_batch_id`,
                [driverId, vehicle_id, zoneId],
            );
            batchIds.push(route_batch_id);
            dispatchId = await insertDispatch('delivered', route_batch_id);
            await db.query(
                `INSERT INTO dispatch_ratings (dispatch_id, score, comment, created_at)
                 VALUES ($1, 5, 'Todo llegó en perfecto estado', '2040-01-01T10:01:00Z')`,
                [dispatchId],
            );

            await db.query(
                `INSERT INTO dispatch_packages (dispatch_id, external_package_id, length_cm, width_cm, height_cm, gross_weight_kg)
                 VALUES ($1, $2, 40, 30, 20, 5.5), ($1, $3, 10, 10, 10, 1)`,
                [dispatchId, `DD-PKG-${run}-1`, `DD-PKG-${run}-2`],
            );

            // Fuera de orden a propósito: la ficha los devuelve por hora.
            await insertEvent(dispatchId, 'status_changed', '2040-01-01T10:00:00Z', driverId, { status: 'delivered', lat: -16.51, lng: -68.16, accuracy: 5, outboundRecordVersion: 9, secret: 'no-debe-salir' }, 'entregado');
            await insertEvent(dispatchId, 'created', '2040-01-01T08:00:00Z', null, null);
            await insertEvent(dispatchId, 'assigned', '2040-01-01T09:00:00Z', coordinatorId, { status: 'assigned' });

            await db.query(
                `INSERT INTO dispatch_incidents (dispatch_incident_id, dispatch_id, incident_reason_id, description) VALUES ($1, $2, $3, 'Nadie atendió')`,
                [randomUUID(), dispatchId, incidentReasonId],
            );
            await db.query(
                `INSERT INTO dispatch_reschedules (dispatch_id, reschedule_reason_id, rescheduled_by, rescheduled_by_type, new_route_batch_id, new_window_start, new_window_end)
                 VALUES ($1, $2, $3, 'coordinator', $4, '2040-01-01T13:00:00Z', '2040-01-01T15:00:00Z')`,
                [dispatchId, rescheduleReasonId, coordinatorId, route_batch_id],
            );

            await mkdir(uploadsDir, { recursive: true });
            photoFile = `${randomUUID()}.jpg`;
            files.push(join(uploadsDir, photoFile));
            await writeFile(join(uploadsDir, photoFile), Buffer.from('fake-jpeg'));
            sigId = randomUUID();
            await db.query(
                `INSERT INTO delivery_evidences (delivery_evidence_id, dispatch_id, type, file_url, captured_at, latitude, longitude)
                 VALUES ($1, $2, 'photo', $3, '2040-01-01T09:59:00Z', -16.51, -68.16)`,
                [randomUUID(), dispatchId, `http://localhost:3000/uploads/${photoFile}`],
            );
            await db.query(
                `INSERT INTO delivery_evidences (delivery_evidence_id, dispatch_id, type, file_url, captured_at, receiver_name, receiver_document)
                 VALUES ($1, $2, 'signature', $3, '2040-01-01T10:00:00Z', 'Ana Receptora', '1234567')`,
                [sigId, dispatchId, `http://localhost:3000/uploads/${randomUUID()}.png`],
            );
            await db.query(
                `INSERT INTO delivery_evidences (delivery_evidence_id, dispatch_id, type) VALUES ($1, $2, 'otp')`,
                [randomUUID(), dispatchId],
            );
        });

        it('devuelve despacho, destino, bultos, conductor y vehículo en una respuesta (coordinador)', async () => {
            const res = await detail(dispatchId);
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                id: dispatchId, type: { name: 'delivery' }, status: { name: 'delivered' }, paymentStatusLabel: 'Prepaid',
                destination: { address: 'Av. e2e 123', latitude: -16.5, longitude: -68.15, contactName: 'E2E customer', zone: { name: `Zona dd ${run}` } },
                route: { status: 'in_execution', sequenceOrder: 1, driver: { id: driverId, fullName: `Dd driver ${run}` }, vehicle: { model: 'Hiace e2e', type: 'van' } },
            });
            expect(res.body.packages).toHaveLength(2);
            expect(res.body.packages[0]).toMatchObject({ lengthCm: 40, grossWeightKg: 5.5 });
            expect(res.body.rating).toEqual({ score: 5, comment: 'Todo llegó en perfecto estado', createdAt: '2040-01-01T10:01:00.000Z' });
            expect((await detail(dispatchId, 'supervisor')).body.rating).toEqual(res.body.rating);
        });

        it('el supervisor también puede verla', async () => {
            expect((await detail(dispatchId, 'supervisor')).status).toBe(200);
        });

        it('ordena la línea de tiempo por hora y muestra solo estado, hora, coordenadas y operador', async () => {
            const { timeline } = (await detail(dispatchId)).body;
            expect(timeline.map((e: { eventType: string }) => e.eventType)).toEqual(['created', 'assigned', 'status_changed']);
            expect(timeline[0]).toMatchObject({ actorType: 'system', operator: null, latitude: null, longitude: null });
            expect(timeline[1]).toMatchObject({ status: 'assigned', operator: { id: coordinatorId } });
            expect(timeline[2]).toMatchObject({ status: 'delivered', latitude: -16.51, longitude: -68.16, operator: { id: driverId }, detail: 'entregado' });
            expect(JSON.stringify(timeline)).not.toContain('no-debe-salir');
            expect(JSON.stringify(timeline)).not.toContain('outboundRecordVersion');
        });

        it('incluye incidencias y reprogramaciones', async () => {
            const { incidents, reschedules } = (await detail(dispatchId)).body;
            expect(incidents).toHaveLength(1);
            expect(incidents[0]).toMatchObject({ description: 'Nadie atendió', reasonCode: expect.any(String) });
            expect(reschedules).toHaveLength(1);
            expect(reschedules[0]).toMatchObject({ rescheduledByType: 'coordinator', rescheduledBy: { id: coordinatorId }, newWindowStart: '2040-01-01T13:00:00.000Z' });
        });

        it('entrega las evidencias con URL firmada de corta duración y sin la ruta física', async () => {
            const res = await detail(dispatchId);
            const { evidences, receiver } = res.body;
            expect(evidences.map((e: { type: string }) => e.type)).toEqual(['photo', 'signature', 'otp']);
            expect(evidences[0]).toMatchObject({ latitude: -16.51, longitude: -68.16, capturedAt: '2040-01-01T09:59:00.000Z' });
            expect(evidences[0].accessUrl).toMatch(/\/uploads\/.+\?exp=\d+&sig=[0-9a-f]{64}$/);
            const ttlMs = new Date(evidences[0].accessUrlExpiresAt).getTime() - Date.now();
            expect(ttlMs).toBeGreaterThan(0);
            expect(ttlMs).toBeLessThanOrEqual(300_000);
            expect(evidences[2]).toMatchObject({ accessUrl: null, accessUrlExpiresAt: null });
            expect(receiver).toMatchObject({ id: sigId, receiverName: 'Ana Receptora', receiverDocument: '1234567' });
            const text = JSON.stringify(res.body);
            expect(text).not.toContain('fileUrl');
            expect(text).not.toContain('file_url');
            expect(text).not.toContain('otpCode');
            expect(text).not.toContain('http://localhost:3000/uploads/' + photoFile + '"');
        });

        it('la URL firmada abre el archivo; sin firma, manipulada o con otro nombre responde 404', async () => {
            const { evidences } = (await detail(dispatchId)).body;
            const url = new URL(evidences[0].accessUrl as string);
            const signed = `${url.pathname}${url.search}`;
            const ok = await http().get(signed);
            expect(ok.status).toBe(200);
            expect(ok.headers['cache-control']).toContain('no-store');

            expect((await http().get(url.pathname)).status).toBe(404);
            expect((await http().get(signed.replace(/sig=./, 'sig=0'))).status).toBe(404);
            expect((await http().get(signed.replace(/exp=\d+/, 'exp=1'))).status).toBe(404);
            expect((await http().get(`/${prefix}/uploads/${randomUUID()}.jpg${url.search}`)).status).toBe(404);
        });
    });

    describe('sin evidencias', () => {
        it('responde 200 con listas vacías, sin receptor y sin ruta', async () => {
            const id = await insertDispatch('pending');
            const res = await detail(id);
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ id, evidences: [], incidents: [], reschedules: [], timeline: [], packages: [], receiver: null, route: null, rating: null });
        });
    });

    describe('autorización y errores', () => {
        let dispatchId: number;
        beforeAll(async () => { dispatchId = await insertDispatch('pending'); });

        it('403 con rol no autorizado (repartidor y administrador)', async () => {
            for (const key of ['driver', 'admin']) {
                const res = await detail(dispatchId, key);
                expect(res.status).toBe(403);
                expect(res.body.error).toBe('INSUFFICIENT_PERMISSIONS');
            }
        });

        it('401 sin token', async () => {
            expect((await http().get(api(`/dispatches/${dispatchId}/detail`))).status).toBe(401);
        });

        it('404 DISPATCH_NOT_FOUND si el despacho no existe', async () => {
            const res = await detail(2147483000);
            expect(res.status).toBe(404);
            expect(res.body.error).toBe('DISPATCH_NOT_FOUND');
        });

        it('400 con un id no numérico', async () => {
            expect((await detail('abc')).status).toBe(400);
        });
    });

    describe('rendimiento con 100 eventos', () => {
        it('responde en menos de 1 s con 100 eventos y 10 evidencias', async () => {
            const id = await insertDispatch('in_transit');
            const rows = Array.from({ length: 100 }, (_, i) => i);
            await db.query(
                `INSERT INTO dispatch_events (dispatch_id, event_type, actor_user_id, actor_type, metadata, created_at)
                 SELECT $1, 'location_update', $2, 'user', jsonb_build_object('latitude', -16.5, 'longitude', -68.1), '2040-02-01T00:00:00Z'::timestamptz + n * interval '1 minute'
                 FROM unnest($3::int[]) AS n`,
                [id, driverId, rows],
            );
            for (let i = 0; i < 10; i++) {
                await db.query(`INSERT INTO delivery_evidences (delivery_evidence_id, dispatch_id, type, file_url) VALUES ($1, $2, 'photo', $3)`, [randomUUID(), id, `http://localhost:3000/uploads/${randomUUID()}.jpg`]);
            }
            await detail(id); // calienta la conexión y los planes
            const started = performance.now();
            const res = await detail(id);
            const elapsed = performance.now() - started;
            expect(res.status).toBe(200);
            expect(res.body.timeline).toHaveLength(100);
            expect(res.body.evidences).toHaveLength(10);
            expect(elapsed).toBeLessThan(1000);
        });
    });
});
