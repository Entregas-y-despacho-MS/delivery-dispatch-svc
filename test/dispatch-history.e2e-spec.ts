// ST-55.2 — GET /dispatches/history: historial de despachos (RF-A08).
//
// Levanta el AppModule real contra una base real (con la migración 020: `dispatches.closed_at`). Todo lo que crea lleva un
// prefijo único por corrida y se borra en afterAll. Los filtros incluyen siempre el código de guía de la corrida (`search`),
// así los conteos no dependen de lo que haya en la base compartida.
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

describe('GET /dispatches/history (e2e, ST-55.2)', () => {
    let app: INestApplication;
    let db: DataSource;
    let prefix: string;
    const run = Date.now().toString(36).toUpperCase();
    const tag = 'e2e_dh_';
    const code = `EH${run}`;
    const tokens: Record<string, string> = {};
    const refs: string[] = [];
    const batchIds: number[] = [];
    const vehicleIds: number[] = [];
    const statusIds: Record<string, number> = {};
    const ids: Record<string, number> = {};
    let deliveryTypeId: number;
    let activeVehicleStatusId: number;
    let driverA: number;
    let driverB: number;
    let plateA: string;
    let plateB: string;

    const http = () => request(app.getHttpServer());
    const api = (path: string) => `/${prefix}${path}`;
    const history = (query: Record<string, string | number> = {}, key = 'coordinator') =>
        http().get(api('/dispatches/history')).query({ search: code, ...query }).set({ Authorization: `Bearer ${tokens[key]}` });
    const idsOf = (body: { data: { id: number }[] }) => body.data.map((item) => item.id);

    const createUser = async (key: string, role: string): Promise<number> => {
        const username = `${tag}${key}_${run}`;
        const [{ user_id }] = await db.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change, active)
             VALUES ((SELECT role_id FROM roles WHERE name = $1), $2, $3, $4, FALSE, TRUE) RETURNING user_id`,
            [role, `Dh ${key} ${run}`, username, await hashPassword('E2eTest1234')],
        );
        const res = await http().post(api('/auth/login')).send({ username, password: 'E2eTest1234' });
        tokens[key] = res.body.accessToken as string;
        return user_id as number;
    };

    const createBatch = async (driverId: number, plate: string, shiftDate: string): Promise<number> => {
        const [{ vehicle_id }] = await db.query(
            `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3)
             VALUES ($1, 'van', 'Hiace e2e', $2, 100, 10) RETURNING vehicle_id`,
            [activeVehicleStatusId, plate],
        );
        vehicleIds.push(vehicle_id);
        const [{ route_batch_id }] = await db.query(
            `INSERT INTO route_batches (status, shift_date, driver_id, vehicle_id, version)
             VALUES ('closed', $1, $2, $3, 0) RETURNING route_batch_id`,
            [shiftDate, driverId, vehicle_id],
        );
        batchIds.push(route_batch_id);
        return route_batch_id as number;
    };

    const insertDispatch = async (key: string, status: string, batchId: number | null, closedAt: string | null): Promise<number> => {
        const ref = `DH-${run}-${key}`;
        refs.push(ref);
        const [{ dispatch_id }] = await db.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, source_order_ref, tracking_code, delivery_address, contact_name, closed_at)
             VALUES ($1, $2, $3, $4, $5, 'Av. e2e 123', $6, $7) RETURNING dispatch_id`,
            [deliveryTypeId, statusIds[status], batchId, ref, `${code}${key}`, `Cliente ${key}`, closedAt],
        );
        ids[key] = dispatch_id as number;
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

        await createUser('coordinator', 'coordinator');
        await createUser('supervisor', 'supervisor');
        await createUser('admin', 'admin');
        await createUser('driver', 'driver');
        driverA = await createUser('driverA', 'driver');
        driverB = await createUser('driverB', 'driver');

        plateA = `HA${run.slice(-6)}`;
        plateB = `HB${run.slice(-6)}`;
        const batchA = await createBatch(driverA, plateA, '2040-03-10');
        const batchB = await createBatch(driverB, plateB, '2040-03-20');

        // 2040-03-10 23:30 in La Paz (UTC-4) is already 2040-03-11 03:30 UTC: the Bolivia day, not the UTC day, decides the range.
        await insertDispatch('1', 'delivered', batchA, '2040-03-10T15:00:00.000Z');
        await insertDispatch('2', 'delivered', batchB, '2040-03-20T15:00:00.000Z');
        await insertDispatch('3', 'not_delivered', batchA, '2040-04-02T15:00:00.000Z');
        await insertDispatch('4', 'returned', batchB, '2040-03-11T04:00:00.000Z'); // 2040-03-11 00:00 La Paz
        await insertDispatch('5', 'cancelled', null, '2040-03-15T15:00:00.000Z');
        await insertDispatch('6', 'delivered', batchA, '2040-03-11T03:30:00.000Z'); // 2040-03-10 23:30 La Paz
        await insertDispatch('7', 'returned_to_warehouse', batchA, '2040-05-01T15:00:00.000Z');
        // Not finished: never part of the history.
        await insertDispatch('8', 'in_transit', batchA, null);
        await insertDispatch('9', 'pending', null, null);

        // Departure of dispatch 1: «Iniciar ruta» wrote the departure time in the metadata of the event.
        await db.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, actor_user_id, actor_type, metadata, created_at)
             VALUES ($1, 'status_changed', $2, 'user', $3::jsonb, '2040-03-10T12:00:01.000Z')`,
            [ids['1'], driverA, JSON.stringify({ status: 'out_for_delivery', departedAt: '2040-03-10T12:00:00.000Z' })],
        );
    });

    afterAll(async () => {
        if (db) {
            await withEventPurge(db, { dispatchRefs: [`DH-${run}-%`], routeBatchIds: batchIds, userNames: [`${tag}%_${run}`] }, async (manager) => {
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`DH-${run}-%`]);
                await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
                await manager.query(`DELETE FROM vehicles WHERE vehicle_id = ANY($1::int[])`, [vehicleIds]);
                await manager.query(`DELETE FROM users WHERE username LIKE $1`, [`${tag}%_${run}`]);
            });
        }
        await app?.close();
    });

    describe('acceso', () => {
        it('sin token → 401', async () => {
            const res = await http().get(api('/dispatches/history'));
            expect(res.status).toBe(401);
        });

        it.each(['driver', 'admin'])('rol %s → 403 INSUFFICIENT_PERMISSIONS', async (role) => {
            const res = await history({}, role);
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('INSUFFICIENT_PERMISSIONS');
        });

        it.each(['coordinator', 'supervisor'])('rol %s → 200', async (role) => {
            const res = await history({}, role);
            expect(res.status).toBe(200);
        });
    });

    describe('qué entra al historial', () => {
        it('solo despachos en estado terminal con fecha de cierre: no aparecen el que va en tránsito ni el pendiente', async () => {
            const res = await history({ limit: 100 });

            expect(res.status).toBe(200);
            expect(res.body.total).toBe(7);
            expect(idsOf(res.body)).not.toContain(ids['8']);
            expect(idsOf(res.body)).not.toContain(ids['9']);
            expect(new Set(res.body.data.map((item: { status: string }) => item.status))).toEqual(
                new Set(['delivered', 'not_delivered', 'returned', 'cancelled', 'returned_to_warehouse']),
            );
        });

        it('el estado decide por sí solo: un despacho que no es terminal no aparece aunque conserve una fecha de cierre', async () => {
            await insertDispatch('H', 'in_transit', null, '2040-08-01T15:00:00.000Z');

            const res = await history({ search: `${code}H` });

            expect(res.status).toBe(200);
            expect(res.body.total).toBe(0);
        });

        it('responde { data, total, page, limit } y cada fila trae repartidor, vehículo y horas', async () => {
            const res = await history({ status: 'delivered', from: '2040-03-10', to: '2040-03-10', plate: plateA, limit: 100, sortBy: 'closedAt', order: 'asc' });

            expect(res.status).toBe(200);
            expect(Object.keys(res.body).sort()).toEqual(['data', 'limit', 'page', 'total']);
            const first = res.body.data.find((item: { id: number }) => item.id === ids['1']);
            expect(first).toEqual({
                id: ids['1'], trackingCode: `${code}1`, recipient: 'Cliente 1', driverId: driverA, driverName: `Dh driverA ${run}`, plate: plateA,
                departedAt: '2040-03-10T12:00:00.000Z', deliveredAt: '2040-03-10T15:00:00.000Z', status: 'delivered', closedAt: '2040-03-10T15:00:00.000Z',
            });
        });

        it('un despacho sin ruta aparece con repartidor y vehículo vacíos, y sin hora de entrega si no se entregó', async () => {
            const res = await history({ status: 'cancelled' });

            expect(res.body.data).toEqual([expect.objectContaining({
                id: ids['5'], status: 'cancelled', driverId: null, driverName: null, plate: null, departedAt: null, deliveredAt: null,
            })]);
        });

        it('la hora de entrega solo existe cuando el estado final es delivered', async () => {
            const res = await history({ limit: 100 });

            for (const item of res.body.data) {
                expect(item.deliveredAt === null).toBe(item.status !== 'delivered');
            }
        });
    });

    describe('filtros combinados', () => {
        it('rango de fechas + repartidor + placa + estado a la vez', async () => {
            const res = await history({ from: '2040-03-01', to: '2040-03-31', driverId: driverA, plate: plateA, status: 'delivered', limit: 100 });

            expect(idsOf(res.body).sort()).toEqual([ids['1'], ids['6']].sort());
            expect(res.body.total).toBe(2);
        });

        it('cada filtro reduce por separado', async () => {
            expect(idsOf((await history({ driverId: driverB, limit: 100 })).body).sort()).toEqual([ids['2'], ids['4']].sort());
            expect(idsOf((await history({ plate: plateB.toLowerCase(), limit: 100 })).body).sort()).toEqual([ids['2'], ids['4']].sort());
            expect(idsOf((await history({ status: 'returned' })).body)).toEqual([ids['4']]);
            expect(idsOf((await history({ search: `${code}3` })).body)).toEqual([ids['3']]);
        });

        it('un repartidor y una placa de rutas distintas no devuelven nada', async () => {
            const res = await history({ driverId: driverA, plate: plateB });

            expect(res.body).toEqual({ data: [], total: 0, page: 1, limit: 10 });
        });

        it('el rango incluye ambos días completos y se mide en hora de Bolivia, no en UTC', async () => {
            // closed 2040-03-10 23:30 La Paz (03-11 03:30 UTC) belongs to 03-10; closed 2040-03-11 00:00 La Paz belongs to 03-11.
            const onTenth = await history({ from: '2040-03-10', to: '2040-03-10', limit: 100 });
            const onEleventh = await history({ from: '2040-03-11', to: '2040-03-11', limit: 100 });

            expect(idsOf(onTenth.body).sort()).toEqual([ids['1'], ids['6']].sort());
            expect(idsOf(onEleventh.body)).toEqual([ids['4']]);
        });

        it('from sin to y to sin from', async () => {
            expect(idsOf((await history({ from: '2040-04-01', limit: 100 })).body).sort()).toEqual([ids['3'], ids['7']].sort());
            expect(idsOf((await history({ to: '2040-03-10', limit: 100 })).body).sort()).toEqual([ids['1'], ids['6']].sort());
        });

        it('% y _ del texto se buscan literalmente', async () => {
            const res = await http().get(api('/dispatches/history')).query({ search: '%' }).set({ Authorization: `Bearer ${tokens.coordinator}` });

            expect(res.status).toBe(200);
            expect(res.body.total).toBe(0);
        });
    });

    describe('paginación y orden', () => {
        it('recorre todo el historial por páginas sin repetir ni saltar filas', async () => {
            const seen: number[] = [];
            for (const page of [1, 2, 3, 4]) {
                const res = await history({ limit: 2, page });
                expect(res.body.total).toBe(7);
                expect(res.body.page).toBe(page);
                expect(res.body.limit).toBe(2);
                seen.push(...idsOf(res.body));
            }

            expect(seen).toHaveLength(7);
            expect(new Set(seen).size).toBe(7);
            expect((await history({ limit: 2, page: 5 })).body).toEqual({ data: [], total: 7, page: 5, limit: 2 });
        });

        it('por defecto, lo más reciente primero; order=asc lo invierte', async () => {
            const desc = idsOf((await history({ limit: 100 })).body);
            const asc = idsOf((await history({ limit: 100, order: 'asc' })).body);

            expect(desc).toEqual([ids['7'], ids['3'], ids['2'], ids['5'], ids['4'], ids['6'], ids['1']]);
            expect(asc).toEqual([...desc].reverse());
        });

        it('sortBy trackingCode, plate y status', async () => {
            expect(idsOf((await history({ limit: 100, sortBy: 'trackingCode', order: 'asc' })).body)).toEqual(
                [ids['1'], ids['2'], ids['3'], ids['4'], ids['5'], ids['6'], ids['7']],
            );
            const byPlate = (await history({ limit: 100, sortBy: 'plate', order: 'asc' })).body.data.map((item: { plate: string | null }) => item.plate);
            expect(byPlate.slice(0, 5)).toEqual([plateA, plateA, plateA, plateA, plateB]);
            expect(byPlate.at(-1)).toBeNull();
            const byStatus = (await history({ limit: 100, sortBy: 'status', order: 'asc' })).body.data.map((item: { status: string }) => item.status);
            expect(byStatus).toEqual([...byStatus].sort());
        });
    });

    describe('validación', () => {
        it.each([
            ['limit mayor que 100', { limit: 101 }, "The 'limit' parameter must be <= 100."],
            ['page menor que 1', { page: 0 }, "The 'page' parameter must be >= 1."],
            ['fecha inválida', { from: '2040-13-01' }, "The 'from' parameter must be a valid date in YYYY-MM-DD format."],
            ['fecha con hora', { to: '2040-03-01T10:00:00Z' }, "The 'to' parameter must be a valid date in YYYY-MM-DD format."],
            ['sortBy desconocido', { sortBy: 'closed_at; DROP TABLE dispatches' }, "The 'sortBy' parameter must be one of: closedAt, trackingCode, recipient, driver, plate, status."],
            ['order desconocido', { order: 'sideways' }, "The 'order' parameter must be 'asc' or 'desc'."],
            ['estado no terminal', { status: 'pending' }, "The 'status' parameter must be one of: delivered, not_delivered, returned, returned_to_warehouse, cancelled."],
            ['driverId no entero', { driverId: 'abc' }, "The 'driverId' parameter must be an integer."],
        ])('%s → 400', async (_name, query, message) => {
            const res = await history(query as Record<string, string | number>);

            expect(res.status).toBe(400);
            expect(res.body.message).toContain(message);
        });

        it('from posterior a to → 400 INVALID_DATE_RANGE', async () => {
            const res = await history({ from: '2040-03-10', to: '2040-03-09' });

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('INVALID_DATE_RANGE');
        });
    });

    describe('exportación CSV', () => {
        const BOM = '﻿';
        const HEADER = 'Código de traslado,Cliente,Repartidor,Vehículo,Hora de partida,Hora de entrega,Estado';
        // supertest only keeps the body of a response it knows how to parse: read it as text.
        const exportCsv = (query: Record<string, string | number> = {}, key = 'coordinator') =>
            http().get(api('/dispatches/history/export')).query({ search: code, ...query }).set({ Authorization: `Bearer ${tokens[key]}` })
                .buffer(true).parse((res, done) => { let text = ''; res.setEncoding('utf8'); res.on('data', (chunk: string) => { text += chunk; }); res.on('end', () => done(null, text)); });
        const lines = (res: { body: unknown }): string[] => String(res.body).split('\r\n').filter(Boolean);
        const codesOf = (res: { body: unknown }): string[] => lines(res).slice(1).map((line) => line.split(',')[0]);

        describe('acceso', () => {
            it('sin token → 401', async () => {
                expect((await http().get(api('/dispatches/history/export'))).status).toBe(401);
            });

            it.each(['driver', 'admin'])('rol %s → 403', async (role) => {
                const res = await exportCsv({}, role);
                expect(res.status).toBe(403);
            });

            it.each(['coordinator', 'supervisor'])('rol %s → 200', async (role) => {
                expect((await exportCsv({}, role)).status).toBe(200);
            });
        });

        it('responde un archivo CSV en UTF-8 para descargar', async () => {
            const res = await exportCsv();

            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
            expect(res.headers['content-disposition']).toMatch(/^attachment; filename="historial-despachos-\d{4}-\d{2}-\d{2}\.csv"$/);
        });

        it('empieza con la marca BOM y la fila de encabezado, y trae una fila por despacho del historial', async () => {
            const res = await exportCsv();

            expect(String(res.body).startsWith(BOM + HEADER + '\r\n')).toBe(true);
            expect(lines(res)).toHaveLength(1 + 7);
        });

        it('cada fila trae código, cliente, repartidor, vehículo, partida, entrega y estado (horas de Bolivia, estado en español)', async () => {
            const res = await exportCsv({ search: `${code}1` });

            expect(lines(res)[1]).toBe(`${code}1,Cliente 1,Dh driverA ${run},${plateA},2040-03-10 08:00:00,2040-03-10 11:00:00,Entregado`);
        });

        it('un despacho sin ruta ni entrega sale con esas celdas vacías', async () => {
            const res = await exportCsv({ status: 'cancelled' });

            expect(lines(res)[1]).toBe(`${code}5,Cliente 5,,,,,Cancelado`);
        });

        it('aplica los mismos filtros y el mismo orden que el listado', async () => {
            const filters = { from: '2040-03-01', to: '2040-03-31', plate: plateA.toLowerCase(), order: 'asc' } as const;

            const listed = (await history({ ...filters, limit: 100 })).body.data.map((item: { trackingCode: string }) => item.trackingCode);
            const exported = codesOf(await exportCsv(filters));

            expect(exported).toEqual(listed);
            expect(exported).toEqual([`${code}1`, `${code}6`]);
        });

        it('no pagina: ignora page y limit y devuelve todo el historial filtrado', async () => {
            const res = await exportCsv({ page: 2, limit: 2 });

            expect(res.status).toBe(200);
            expect(codesOf(res)).toHaveLength(7);
        });

        it('sin resultados: solo la fila de encabezado', async () => {
            const res = await exportCsv({ driverId: driverA, plate: plateB });

            expect(String(res.body)).toBe(BOM + HEADER + '\r\n');
        });

        it('filtros inválidos → 400 JSON antes de enviar nada', async () => {
            const badRange = await exportCsv({ from: '2040-03-10', to: '2040-03-09' });
            const badStatus = await exportCsv({ status: 'pending' });

            expect(badRange.status).toBe(400);
            expect(JSON.parse(String(badRange.body)).error).toBe('INVALID_DATE_RANGE');
            expect(badStatus.status).toBe(400);
            expect(badStatus.headers['content-type']).toMatch(/json/);
        });

        it('neutraliza las fórmulas y escapa comas y comillas del nombre del cliente', async () => {
            await insertDispatch('F', 'delivered', null, '2040-07-01T15:00:00.000Z');
            await db.query(`UPDATE dispatches SET contact_name = $1 WHERE dispatch_id = $2`, ['=HYPERLINK("http://x","y")', ids['F']]);
            await insertDispatch('G', 'delivered', null, '2040-07-02T15:00:00.000Z');
            await db.query(`UPDATE dispatches SET contact_name = $1 WHERE dispatch_id = $2`, ['Pérez, "Ana"', ids['G']]);

            const formula = await exportCsv({ search: `${code}F` });
            const quoted = await exportCsv({ search: `${code}G` });

            expect(lines(formula)[1].startsWith(`${code}F,"'=HYPERLINK(""http://x"",""y"")",`)).toBe(true);
            expect(lines(quoted)[1].startsWith(`${code}G,"Pérez, ""Ana""",`)).toBe(true);
        });

        it('recorre más de un lote del cursor sin perder ni repetir filas, en el orden pedido', async () => {
            const total = 1203; // more than two batches of 500
            const [{ route_batch_id }] = await db.query(`SELECT route_batch_id FROM route_batches WHERE route_batch_id = ANY($1::int[]) ORDER BY route_batch_id LIMIT 1`, [batchIds]);
            await db.query(
                `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, source_order_ref, tracking_code, delivery_address, contact_name, closed_at)
                 SELECT $1, $2, $3, 'DH-' || $4 || '-BULK' || g, $5 || 'BULK' || lpad(g::text, 5, '0'), 'Av. e2e', 'Cliente bulk', '2041-01-01T12:00:00Z'::timestamptz + g * interval '1 minute'
                   FROM generate_series(1, $6::int) g`,
                [deliveryTypeId, statusIds['delivered'], route_batch_id, run, code, total],
            );

            const res = await exportCsv({ search: `${code}BULK` });
            const codes = codesOf(res);

            expect(res.status).toBe(200);
            expect(codes).toHaveLength(total);
            expect(new Set(codes).size).toBe(total);
            expect(codes[0]).toBe(`${code}BULK${String(total).padStart(5, '0')}`); // most recent first
            expect(codes.at(-1)).toBe(`${code}BULK00001`);
            expect((await history({ search: `${code}BULK`, limit: 1 })).body.total).toBe(total);
        });
    });

    describe('fecha de cierre en la base (trigger)', () => {
        it('un despacho que sale del estado terminal deja el historial, y al terminar de nuevo vuelve con su nueva hora', async () => {
            const id = await insertDispatch('A', 'not_delivered', null, '2040-06-01T15:00:00.000Z');
            expect(idsOf((await history({ search: `${code}A` })).body)).toEqual([id]);

            // The coordinator reschedules it: it is no longer finished.
            await db.query(`UPDATE dispatches SET dispatch_status_id = $1 WHERE dispatch_id = $2`, [statusIds['rescheduled'], id]);
            expect((await history({ search: `${code}A` })).body.total).toBe(0);

            // And it ends again, without the writer saying when: the database puts the time.
            await db.query(`UPDATE dispatches SET dispatch_status_id = $1 WHERE dispatch_id = $2`, [statusIds['returned'], id]);
            const again = await history({ search: `${code}A` });
            expect(idsOf(again.body)).toEqual([id]);
            expect(new Date(again.body.data[0].closedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
        });
    });
});
