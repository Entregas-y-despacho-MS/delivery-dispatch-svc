// ST-215.5 — GET /route-batches y GET /route-batches/:id: consulta de lotes para la revisión.
//
// Levanta el AppModule real contra una base real. Todo lo que crea lleva un prefijo único por corrida y una fecha de
// turno propia (los filtros de la lista siempre incluyen esa fecha), y se borra en afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

describe('GET /route-batches y GET /route-batches/:id (e2e, ST-215.5)', () => {
    let app: INestApplication;
    let db: DataSource;
    let prefix: string;
    const run = Date.now().toString(36).toUpperCase();
    const tag = `e2e_rbq_`;
    const userIds: Record<string, number> = {};
    const tokens: Record<string, string> = {};
    const batchIds: number[] = [];
    const vehicleIds: number[] = [];
    const refs: string[] = [];
    let zoneId: number;
    let activeVehicleStatusId: number;
    let deliveryTypeId: number;
    const statusIds: Record<string, number> = {};

    // Una fecha lejana distinta por corrida: la lista se filtra siempre por ella y no ve filas de otros suites.
    const shiftDate = new Date(Date.UTC(2040, 0, 1) + (Date.now() % 4000) * 86_400_000).toISOString().slice(0, 10);
    const otherShiftDate = new Date(Date.UTC(2040, 0, 1) + ((Date.now() % 4000) + 4001) * 86_400_000).toISOString().slice(0, 10);

    const http = () => request(app.getHttpServer());
    const api = (path: string) => `/${prefix}${path}`;
    const auth = (key: string) => ({ Authorization: `Bearer ${tokens[key]}` });
    const list = (query: Record<string, string | number>, key = 'coordinator') =>
        http().get(api('/route-batches')).query({ shiftDate, ...query }).set(auth(key));
    const detail = (id: number | string, key = 'coordinator') => http().get(api(`/route-batches/${id}`)).set(auth(key));

    const createUser = async (key: string, role: string, login = true) => {
        const username = `${tag}${key}_${run}`;
        const [{ user_id }] = await db.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change, active)
             VALUES ((SELECT role_id FROM roles WHERE name = $1), $2, $3, $4, FALSE, TRUE) RETURNING user_id`,
            [role, `Rbq ${key} ${run}`, username, await hashPassword('E2eTest1234')],
        );
        userIds[key] = user_id;
        if (login) {
            const res = await http().post(api('/auth/login')).send({ username, password: 'E2eTest1234' });
            tokens[key] = res.body.accessToken as string;
        }
    };

    const insertVehicle = async (capacityKg = 100, capacityM3 = 10): Promise<number> => {
        const [{ vehicle_id }] = await db.query(
            `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3)
             VALUES ($1, 'van', 'RBQ e2e', $2, $3, $4) RETURNING vehicle_id`,
            [activeVehicleStatusId, `Q${run.slice(-5)}${vehicleIds.length}`, capacityKg, capacityM3],
        );
        vehicleIds.push(vehicle_id);
        return vehicle_id as number;
    };

    const insertBatch = async (opts: {
        status?: string; reviewer?: number | null; vehicleId?: number | null; date?: string; version?: number; driverId?: number | null;
    } = {}): Promise<number> => {
        const [{ route_batch_id }] = await db.query(
            `INSERT INTO route_batches (status, shift_date, reviewer_user_id, vehicle_id, delivery_zone_id, proposed_driver_id, version)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING route_batch_id`,
            [opts.status ?? 'provisional', opts.date ?? shiftDate, opts.reviewer ?? null, opts.vehicleId ?? null, zoneId, opts.driverId ?? null, opts.version ?? 0],
        );
        batchIds.push(route_batch_id);
        return route_batch_id as number;
    };

    const insertDispatch = async (batchId: number, seq: number | null, opts: { version?: number; weight?: number; status?: string } = {}): Promise<number> => {
        const ref = `RBQ-${run}-${refs.length}`;
        refs.push(ref);
        const [{ dispatch_id }] = await db.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order, source_order_ref,
                delivery_address, contact_name, estimated_weight_kg, version, scheduled_window_start, scheduled_window_end)
             VALUES ($1, $2, $3, $4, $5, 'Av. e2e 123', 'E2E customer', $6, $7, '2040-01-02T13:00:00Z', '2040-01-02T15:00:00Z')
             RETURNING dispatch_id`,
            [deliveryTypeId, statusIds[opts.status ?? 'in_planning'], batchId, seq, ref, opts.weight ?? 5, opts.version ?? 0],
        );
        return dispatch_id as number;
    };

    const insertPackage = async (dispatchId: number, n: number, l: number, w: number, h: number, kg: number) =>
        await db.query(
            `INSERT INTO dispatch_packages (dispatch_id, external_package_id, length_cm, width_cm, height_cm, gross_weight_kg)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [dispatchId, `RBQ-PKG-${run}-${dispatchId}-${n}`, l, w, h, kg],
        );

    const insertCutoffEvent = async (batchId: number, type: 'cutoff_validated' | 'cutoff_failed', createdAt: string, reason: string | null, metadata: object) =>
        await db.query(
            `INSERT INTO route_batch_events (route_batch_id, event_type, actor_type, reason, metadata, created_at)
             VALUES ($1, $2, 'system', $3, $4::jsonb, $5)`,
            [batchId, type, reason, JSON.stringify(metadata), createdAt],
        );

    const snapshot = async (id: number) => ({
        batch: (await db.query(`SELECT version, status, reviewer_user_id, vehicle_id FROM route_batches WHERE route_batch_id = $1`, [id]))[0],
        dispatches: await db.query(`SELECT dispatch_id, version, dispatch_status_id, route_batch_id FROM dispatches WHERE route_batch_id = $1 ORDER BY dispatch_id`, [id]),
        events: Number((await db.query(`SELECT COUNT(*) AS n FROM route_batch_events WHERE route_batch_id = $1`, [id]))[0].n),
    });

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
            [`RQ${run}`.slice(0, 20), `Zona rbq ${run}`],
        );

        await createUser('coordinator', 'coordinator');
        await createUser('otherCoordinator', 'coordinator', false);
        await createUser('supervisor', 'supervisor');
        await createUser('admin', 'admin');
        await createUser('driver', 'driver');
    });

    afterAll(async () => {
        if (db) {
            await withEventPurge(db, { dispatchRefs: refs.map((ref) => `${ref}%`), routeBatchIds: batchIds, userNames: [`${tag}%_${run}`] }, async (manager) => {
                await manager.query(`DELETE FROM dispatch_packages WHERE dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE source_order_ref LIKE ANY($1::text[]))`, [refs.map((ref) => `${ref}%`)]);
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref = ANY($1::text[])`, [refs]);
                await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
                await manager.query(`DELETE FROM vehicles WHERE vehicle_id = ANY($1::int[])`, [vehicleIds]);
                await manager.query(`DELETE FROM delivery_zones WHERE delivery_zone_id = $1`, [zoneId]);
                await manager.query(`DELETE FROM users WHERE username LIKE $1`, [`${tag}%_${run}`]);
            });
        }
        await app?.close();
    });

    describe('permisos', () => {
        it('sin token es 401 en la lista y en el detalle', async () => {
            expect((await http().get(api('/route-batches'))).status).toBe(401);
            expect((await http().get(api('/route-batches/1'))).status).toBe(401);
        });

        it('un administrador y un repartidor reciben 403; coordinador y supervisor pueden leer', async () => {
            const id = await insertBatch();
            for (const key of ['admin', 'driver']) {
                const res = await detail(id, key);
                expect(res.status).toBe(403);
                expect(res.body.error).toBe('INSUFFICIENT_PERMISSIONS');
                expect((await list({}, key)).status).toBe(403);
            }
            expect((await detail(id, 'coordinator')).status).toBe(200);
            expect((await detail(id, 'supervisor')).status).toBe(200);
            expect((await list({}, 'supervisor')).status).toBe(200);
        });
    });

    describe('lista', () => {
        it('filtra por estado: provisional y pending_final_review no se mezclan', async () => {
            const date = new Date(Date.UTC(2041, 0, 1) + (Date.now() % 4000) * 86_400_000).toISOString().slice(0, 10);
            const provisional = await insertBatch({ status: 'provisional', date, reviewer: userIds.coordinator });
            const pending = await insertBatch({ status: 'pending_final_review', date, reviewer: userIds.coordinator });
            const confirmed = await insertBatch({ status: 'confirmed', date, reviewer: userIds.coordinator });

            const idsOf = async (status?: string) =>
                ((await http().get(api('/route-batches')).query({ shiftDate: date, ...(status ? { status } : {}) }).set(auth('coordinator'))).body.data as Array<{ id: number }>).map((row) => row.id);

            expect(await idsOf('provisional')).toEqual([provisional]);
            expect(await idsOf('pending_final_review')).toEqual([pending]);
            expect(await idsOf('confirmed')).toEqual([confirmed]);
            expect(await idsOf()).toEqual([provisional, pending, confirmed]);
        });

        it('filtra por fecha del turno', async () => {
            const here = await insertBatch({ date: shiftDate });
            const there = await insertBatch({ date: otherShiftDate });

            const ids = (rows: Array<{ id: number }>) => rows.map((row) => row.id);
            expect(ids((await list({ shiftDate })).body.data)).toContain(here);
            expect(ids((await list({ shiftDate })).body.data)).not.toContain(there);
            expect(ids((await list({ shiftDate: otherShiftDate })).body.data)).toEqual([there]);
        });

        it('cada fila trae versión, zona, vehículo, conductor propuesto, revisor, cantidad de pedidos y ocupación con los estimados', async () => {
            const vehicleId = await insertVehicle(100, 10);
            const date = new Date(Date.UTC(2042, 0, 1) + (Date.now() % 4000) * 86_400_000).toISOString().slice(0, 10);
            const id = await insertBatch({ date, reviewer: userIds.coordinator, vehicleId, version: 3, driverId: userIds.driver });
            const withPackages = await insertDispatch(id, 1);
            const estimated = await insertDispatch(id, 2, { weight: 20 });
            await insertPackage(withPackages, 1, 100, 50, 20, 30);

            const res = await http().get(api('/route-batches')).query({ shiftDate: date }).set(auth('coordinator'));

            expect(res.status).toBe(200);
            expect(res.body.meta).toEqual({ page: 1, limit: 10, total: 1, pages: 1 });
            const [row] = res.body.data;
            expect(row).toMatchObject({
                id, status: 'provisional', version: 3, shiftDate: date, dispatchCount: 2,
                zone: { id: zoneId, name: `Zona rbq ${run}` },
                vehicle: { id: vehicleId, model: 'RBQ e2e', type: 'van' },
                proposedDriver: { id: userIds.driver }, reviewer: { id: userIds.coordinator, fullName: `Rbq coordinator ${run}` },
                occupancy: {
                    weight: { actual: 50, capacity: 100, usedPercent: 50 },
                    volume: { actual: 0.1, capacity: 10, usedPercent: 1 },
                    estimatedDispatchIds: [estimated], assignable: true,
                },
            });
        });

        it('un lote sin vehículo sale con ocupación nula en vez de fallar', async () => {
            const date = new Date(Date.UTC(2043, 0, 1) + (Date.now() % 4000) * 86_400_000).toISOString().slice(0, 10);
            const id = await insertBatch({ date, reviewer: userIds.coordinator, vehicleId: null });
            await insertDispatch(id, 1);

            const res = await http().get(api('/route-batches')).query({ shiftDate: date }).set(auth('coordinator'));

            expect(res.status).toBe(200);
            expect(res.body.data[0]).toMatchObject({ id, vehicle: null, occupancy: null, dispatchCount: 1 });
        });

        it('lote sin revisor: withoutReviewer lo trae solo, y con reviewerUserId trae «los míos o sin revisor»', async () => {
            const date = new Date(Date.UTC(2044, 0, 1) + (Date.now() % 4000) * 86_400_000).toISOString().slice(0, 10);
            const mine = await insertBatch({ date, reviewer: userIds.coordinator });
            const nobodys = await insertBatch({ date, reviewer: null });
            const theirs = await insertBatch({ date, reviewer: userIds.otherCoordinator });
            const ids = async (query: Record<string, string | number>) =>
                ((await http().get(api('/route-batches')).query({ shiftDate: date, ...query }).set(auth('coordinator'))).body.data as Array<{ id: number }>).map((row) => row.id);

            expect(await ids({ withoutReviewer: 'true' })).toEqual([nobodys]);
            expect(await ids({ reviewerUserId: userIds.coordinator })).toEqual([mine]);
            expect(await ids({ reviewerUserId: userIds.coordinator, withoutReviewer: 'true' })).toEqual([mine, nobodys]);
            expect(await ids({ withoutReviewer: 'false' })).toEqual([mine, nobodys, theirs]);
            expect(await ids({})).toEqual([mine, nobodys, theirs]);
            const row = ((await http().get(api('/route-batches')).query({ shiftDate: date, withoutReviewer: 'true' }).set(auth('coordinator'))).body.data[0]);
            expect(row.reviewer).toBeNull();
        });

        it('pagina y ordena por fecha del turno e id', async () => {
            const date = new Date(Date.UTC(2045, 0, 1) + (Date.now() % 4000) * 86_400_000).toISOString().slice(0, 10);
            const created = [await insertBatch({ date }), await insertBatch({ date }), await insertBatch({ date })];

            const first = await http().get(api('/route-batches')).query({ shiftDate: date, page: 1, limit: 2 }).set(auth('coordinator'));
            const second = await http().get(api('/route-batches')).query({ shiftDate: date, page: 2, limit: 2 }).set(auth('coordinator'));

            expect(first.body.meta).toEqual({ page: 1, limit: 2, total: 3, pages: 2 });
            expect(first.body.data.map((row: { id: number }) => row.id)).toEqual(created.slice(0, 2));
            expect(second.body.data.map((row: { id: number }) => row.id)).toEqual(created.slice(2));
        });

        it('rechaza filtros inválidos con 400', async () => {
            for (const query of [{ status: 'nope' }, { shiftDate: '2040-13-45' }, { reviewerUserId: 'abc' }, { withoutReviewer: 'maybe' }, { limit: 101 }]) {
                const res = await http().get(api('/route-batches')).query(query).set(auth('coordinator'));
                expect(res.status, JSON.stringify(query)).toBe(400);
            }
        });
    });

    describe('detalle', () => {
        it('entrega la versión del lote y de cada pedido, en orden de ruta, con franja, bultos y capacidad completa', async () => {
            const vehicleId = await insertVehicle(100, 10);
            const id = await insertBatch({ status: 'pending_final_review', reviewer: userIds.coordinator, vehicleId, version: 4, date: otherShiftDate });
            const second = await insertDispatch(id, 2, { version: 7 });
            const first = await insertDispatch(id, 1, { version: 2 });
            const unsequenced = await insertDispatch(id, null, { version: 0, weight: 8 });
            await insertPackage(first, 1, 100, 50, 20, 30);
            await insertPackage(first, 2, 10, 10, 10, 5);

            const res = await detail(id);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                id, status: 'pending_final_review', version: 4, dispatchCount: 3,
                vehicle: { id: vehicleId }, reviewer: { id: userIds.coordinator },
            });
            expect(res.body.dispatches.map((d: { dispatchId: number }) => d.dispatchId)).toEqual([first, second, unsequenced]);
            expect(res.body.dispatches.map((d: { version: number }) => d.version)).toEqual([2, 7, 0]);
            expect(res.body.dispatches[0]).toMatchObject({
                status: 'in_planning', sequenceOrder: 1, sourceOrderRef: expect.stringContaining('RBQ-'), estimated: false,
                scheduledWindowStart: '2040-01-02T13:00:00.000Z', scheduledWindowEnd: '2040-01-02T15:00:00.000Z',
            });
            expect(res.body.dispatches[0].packages).toEqual([
                expect.objectContaining({ lengthCm: 100, widthCm: 50, heightCm: 20, grossWeightKg: 30 }),
                expect.objectContaining({ lengthCm: 10, widthCm: 10, heightCm: 10, grossWeightKg: 5 }),
            ]);
            expect(res.body.dispatches[1]).toMatchObject({ estimated: true, packages: [] });
            expect(res.body.capacity).toMatchObject({ assignable: true, estimatedDispatchIds: [second, unsequenced].sort((a, b) => a - b) });
            expect(res.body.capacity.weight.actual).toBe(35 + 5 + 8);
            expect(res.body.occupancy.assignable).toBe(true);
            expect(res.body.validation).toBeNull();
        });

        it('un lote sin vehículo ni revisor devuelve capacidad y ocupación nulas', async () => {
            const id = await insertBatch({ reviewer: null, vehicleId: null, date: otherShiftDate });
            await insertDispatch(id, 1);

            const res = await detail(id);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ vehicle: null, reviewer: null, capacity: null, occupancy: null, dispatchCount: 1 });
        });

        it('un lote sobrecargado marca assignable=false con el exceso', async () => {
            const vehicleId = await insertVehicle(10, 10);
            const id = await insertBatch({ vehicleId, date: otherShiftDate, reviewer: userIds.coordinator });
            await insertDispatch(id, 1, { weight: 25 });

            const res = await detail(id);

            expect(res.body.capacity).toMatchObject({ assignable: false, weight: { actual: 25, capacity: 10, excess: 15 } });
        });

        it('un lote devuelto por el corte trae el último motivo: failures y warnings', async () => {
            const id = await insertBatch({ status: 'provisional', reviewer: userIds.coordinator, date: otherShiftDate });
            await insertDispatch(id, 1);
            const failure = { code: 'slot_not_met', dispatchIds: [1], detail: { slot: '13:00' } };
            const warning = { code: 'driver_missing', dispatchIds: [], detail: {} };
            await insertCutoffEvent(id, 'cutoff_validated', '2040-01-01T10:00:00Z', null, { failures: [], warnings: [] });
            await insertCutoffEvent(id, 'cutoff_failed', '2040-01-01T12:00:00Z', 'slot_not_met', { failures: [failure], warnings: [warning], trigger: 'manual' });

            const res = await detail(id);

            expect(res.status).toBe(200);
            expect(res.body.status).toBe('provisional');
            expect(res.body.validation).toEqual({
                result: 'failed', occurredAt: '2040-01-01T12:00:00.000Z', reason: 'slot_not_met', failures: [failure], warnings: [warning],
            });
        });

        it('un lote validado por el corte trae result=validated con sus advertencias', async () => {
            const id = await insertBatch({ status: 'pending_final_review', reviewer: null, date: otherShiftDate });
            await insertCutoffEvent(id, 'cutoff_failed', '2040-01-01T08:00:00Z', 'capacity_exceeded', { failures: [{ code: 'capacity_exceeded', dispatchIds: [], detail: {} }], warnings: [] });
            await insertCutoffEvent(id, 'cutoff_validated', '2040-01-01T09:00:00Z', null, { failures: [], warnings: [{ code: 'driver_missing', dispatchIds: [], detail: {} }] });

            const res = await detail(id);

            expect(res.body.validation).toMatchObject({ result: 'validated', reason: null, failures: [], warnings: [{ code: 'driver_missing' }] });
        });

        it('es solo lectura: no cambia versiones, estados ni eventos', async () => {
            const vehicleId = await insertVehicle(100, 10);
            const id = await insertBatch({ vehicleId, reviewer: userIds.coordinator, version: 6, date: otherShiftDate });
            await insertDispatch(id, 1, { version: 3 });
            await insertCutoffEvent(id, 'cutoff_failed', '2040-01-01T12:00:00Z', 'slot_not_met', { failures: [], warnings: [] });
            const before = await snapshot(id);

            expect((await detail(id)).status).toBe(200);
            expect((await list({ shiftDate: otherShiftDate })).status).toBe(200);

            expect(await snapshot(id)).toEqual(before);
        });

        it('un lote inexistente es 404 ROUTE_BATCH_NOT_FOUND', async () => {
            const res = await detail(2_000_000_000);

            expect(res.status).toBe(404);
            expect(res.body.error).toBe('ROUTE_BATCH_NOT_FOUND');
        });

        it('un id no numérico es 400', async () => {
            expect((await detail('abc')).status).toBe(400);
        });
    });
});
