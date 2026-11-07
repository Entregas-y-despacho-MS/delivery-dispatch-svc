// ST-81.2 (RF-A39, ES-81) — órdenes de recojo domiciliario: creación manual, anulación y listado.
//
// Levanta el AppModule real contra una base de datos real y pega por HTTP con supertest. Todo lo que crea lleva un
// prefijo único por corrida y se borra en afterAll. Las fechas se calculan desde hoy (hora de Bolivia), nunca fijas.
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

const TZ = 'America/La_Paz';

describe('Órdenes de recojo (e2e, ST-81.2)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const tokens: Record<string, string> = {};
    const statusIds: Record<string, number> = {};
    const typeIds: Record<string, number> = {};
    const batchIds: number[] = [];
    const manualRefs: string[] = []; // `MANUAL-<código>` de lo que crea el POST: se borra por referencia exacta
    const userIds: Record<string, number> = {};
    const warehouse = { code: '', inactiveCode: '', id: 0 };

    const run = Date.now().toString(36).toUpperCase();
    const prefix = `PK${run}`;
    let seq = 0;
    let batchSeq = 0;
    let windowSeq = 0;

    const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
    const url = (path: string) => `/${apiPrefix}/pickup-orders${path}`;
    const create = (body: object, role = 'coordinator') => request(app.getHttpServer()).post(url('')).set(auth(role)).send(body);
    const cancel = (id: number | string, body: object = { reason: 'El cliente desistió de la devolución' }, role = 'coordinator') =>
        request(app.getHttpServer()).patch(url(`/${id}/cancel`)).set(auth(role)).send(body);
    const list = (query: string, role = 'coordinator') => request(app.getHttpServer()).get(url(`?${query}`)).set(auth(role));

    /** La fecha local (Bolivia) de hoy + n días, `YYYY-MM-DD`. */
    const day = async (n: number): Promise<string> =>
        (await dataSource.query(`SELECT ((NOW() AT TIME ZONE '${TZ}')::date + $1::int)::text AS d`, [n]))[0].d;
    /** Un rango de días que ningún otro dato de la base usa: aísla el listado de esta suite. */
    const isolatedDay = async (): Promise<string> => await day(1000 + ++windowSeq);

    const validBody = async (extra: object = {}) => ({
        warehouseCode: warehouse.code,
        contactName: `${prefix} Cliente`,
        contactPhone: '+59171234567',
        address: 'Calle 21 de Calacoto 8790, casa 12',
        reference: 'Condominio Las Palmas',
        latitude: -16.5421,
        longitude: -68.0802,
        preferredPickupDate: await isolatedDay(),
        packageContents: '1 notebook con su cargador',
        estimatedBoxes: 2,
        returnReason: 'Falla de encendido dentro de garantía',
        ...extra,
    });

    const created = async (body: object, expected = 201) => {
        const res = await create(body);
        expect(res.status, JSON.stringify(res.body)).toBe(expected);
        if (res.status === 201) manualRefs.push(res.body.sourceOrderRef as string);
        return res;
    };

    const newBatch = async (status: string, opts: { version?: number } = {}): Promise<number> => {
        const [{ route_batch_id: id }] = await dataSource.query(
            `INSERT INTO route_batches (shift_date, status, version) VALUES (DATE '2042-01-01' + $1::int, $2, $3) RETURNING route_batch_id`,
            [batchSeq++, status, opts.version ?? 0],
        );
        batchIds.push(id);
        return id as number;
    };

    /** Inserta un despacho directamente: un recojo de RMA (`origin: 'rma'`), uno manual o una entrega. */
    const insert = async (o: {
        status: string; type?: string; origin?: 'rma' | 'manual'; batchId?: number | null; sequence?: number | null; date?: string | null;
        coordinates?: boolean; name?: string;
    }): Promise<number> => {
        const n = ++seq;
        const type = o.type ?? 'warehouse_return_pickup';
        const [{ code }] = await dataSource.query(`SELECT next_tracking_code() AS code`);
        const ref = o.origin === 'manual' ? `MANUAL-${code}` : `${prefix}-${n}`;
        if (o.origin === 'manual') manualRefs.push(ref);
        const withCoordinates = o.coordinates ?? true;
        const [{ dispatch_id }] = await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order, source_order_ref, tracking_code,
                                     delivery_address, delivery_latitude, delivery_longitude, contact_name, return_reason, preferred_pickup_date,
                                     destination_warehouse_id)
             VALUES ($1, $2, $3, $4, $5, $6, 'Dirección E2E ST-81.2', $7, $8, $9, 'Motivo E2E',
                     ($10::date)::timestamp AT TIME ZONE '${TZ}', $11)
             RETURNING dispatch_id`,
            [
                typeIds[type], statusIds[o.status], o.batchId ?? null, o.sequence ?? null, ref, code,
                withCoordinates ? -16.5 : null, withCoordinates ? -68.1 : null, o.name ?? `${prefix} Cliente ${n}`, o.date ?? null,
                type === 'warehouse_return_pickup' ? warehouse.id : null,
            ],
        );
        return dispatch_id as number;
    };

    const dispatchRow = async (id: number) => (await dataSource.query(
        `SELECT ds.name AS status, d.version, d.route_batch_id, d.sequence_order, d.closed_at, d.source_order_ref, d.tracking_code,
                d.return_reason, d.package_contents, d.estimated_boxes, d.contact_name, d.contact_phone, d.delivery_address,
                d.delivery_latitude, d.delivery_longitude, d.destination_warehouse_id,
                to_char(d.preferred_pickup_date AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS preferred_day,
                dt.name AS type
           FROM dispatches d JOIN dispatch_statuses ds USING (dispatch_status_id) JOIN dispatch_types dt USING (dispatch_type_id)
          WHERE d.dispatch_id = $1`, [id]))[0];
    const batchRow = async (id: number) => (await dataSource.query(`SELECT status, version FROM route_batches WHERE route_batch_id = $1`, [id]))[0];
    const eventsOf = async (id: number, type: string) => await dataSource.query(
        `SELECT actor_user_id, actor_type, reason, metadata FROM dispatch_events WHERE dispatch_id = $1 AND event_type = $2 ORDER BY dispatch_event_id`, [id, type]);
    const cancelEvents = async (id: number) => await dataSource.query(
        `SELECT actor_user_id, actor_type, reason, metadata FROM dispatch_events
          WHERE dispatch_id = $1 AND event_type = 'status_changed' AND metadata->>'status' = 'cancelled' ORDER BY dispatch_event_id`, [id]);
    const outboundCount = async (id: number): Promise<number> => Number((await dataSource.query(
        `SELECT COUNT(*) AS n FROM outbound_messages om JOIN dispatches d ON d.source_order_ref = om.payload->'data'->>'salesOrderId'
          WHERE d.dispatch_id = $1 AND om.type = 'dispatch.transfer.status_changed'`, [id]))[0].n);
    const countByName = async (): Promise<number> => Number((await dataSource.query(
        `SELECT COUNT(*) AS n FROM dispatches WHERE contact_name LIKE $1`, [`${prefix} Cliente%`]))[0].n);

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
        for (const role of ['coordinator', 'supervisor', 'admin', 'driver']) {
            const [{ role_id }] = await dataSource.query(`SELECT role_id FROM roles WHERE name = $1`, [role]);
            const username = `e2e_pk_${role}_${run}`;
            const [{ user_id }] = await dataSource.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false) RETURNING user_id`,
                [role_id, `Recojos ${role} ${run}`, username, passwordHash],
            );
            userIds[role] = user_id;
            const res = await request(app.getHttpServer()).post(`/${apiPrefix}/auth/login`).send({ username, password: 'E2eTest1234' });
            tokens[role] = res.body.accessToken as string;
        }

        for (const r of await dataSource.query(`SELECT dispatch_status_id AS id, name FROM dispatch_statuses`)) statusIds[r.name] = r.id;
        for (const r of await dataSource.query(`SELECT dispatch_type_id AS id, name FROM dispatch_types`)) typeIds[r.name] = r.id;

        warehouse.code = `WH-E${run}`.slice(0, 30);
        warehouse.inactiveCode = `WH-I${run}`.slice(0, 30);
        const rows = await dataSource.query(
            `INSERT INTO warehouses (code, name, address, latitude, longitude, reception_start_time, reception_end_time, active)
             VALUES ($1, $2, 'Almacén E2E', -16.5, -68.1, '08:00', '17:00', TRUE), ($3, $4, 'Almacén inactivo E2E', -16.5, -68.1, '08:00', '17:00', FALSE)
             RETURNING warehouse_id, code`,
            [warehouse.code, `${prefix} Almacén`, warehouse.inactiveCode, `${prefix} Almacén inactivo`],
        );
        warehouse.id = rows.find((r: { code: string }) => r.code === warehouse.code).warehouse_id;
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) {
            await withEventPurge(dataSource, {
                dispatchRefs: [`${prefix}%`, ...manualRefs],
                routeBatchIds: batchIds,
                userNames: [`e2e_pk_%_${run}`],
            }, async (manager) => {
                await manager.query(`DELETE FROM outbound_messages WHERE payload->'data'->>'salesOrderId' LIKE $1`, [`${prefix}%`]);
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1 OR source_order_ref = ANY($2::text[])`, [`${prefix}%`, manualRefs]);
                if (batchIds.length) await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
                await manager.query(`DELETE FROM warehouses WHERE name LIKE $1`, [`${prefix}%`]);
                await manager.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_pk_%_${run}`]);
            });
        }
        await app?.close();
    });

    // ---------------------------------------------------------------------------------------------------------
    describe('POST /pickup-orders', () => {
        it('sin token → 401; admin, supervisor y repartidor → 403', async () => {
            expect((await request(app.getHttpServer()).post(url('')).send(await validBody())).status).toBe(401);
            for (const role of ['admin', 'supervisor', 'driver']) {
                expect((await create(await validBody(), role)).status, role).toBe(403);
            }
        });

        it('crea el recojo en pickup_scheduled, con código de traslado, referencia MANUAL-, motivo, mercadería y almacén', async () => {
            const body = await validBody({ rmaId: 'RMA-2026-0042' });

            const res = await created(body);

            expect(res.body).toMatchObject({
                origin: 'manual', status: 'pickup_scheduled', contactName: body.contactName, contactPhone: '+59171234567', contactEmail: null,
                address: body.address, reference: 'Condominio Las Palmas', latitude: -16.5421, longitude: -68.0802,
                returnReason: body.returnReason, packageContents: body.packageContents, estimatedBoxes: 2,
                preferredPickupDate: body.preferredPickupDate, destinationWarehouse: { id: warehouse.id, code: warehouse.code },
            });
            expect(res.body.trackingCode).toMatch(/^DSP-\d{4}-\d{5}$/);
            expect(res.body.sourceOrderRef).toBe(`MANUAL-${res.body.trackingCode}`);

            const row = await dispatchRow(res.body.id);
            expect(row).toMatchObject({
                type: 'warehouse_return_pickup', status: 'pickup_scheduled', source_order_ref: res.body.sourceOrderRef, tracking_code: res.body.trackingCode,
                return_reason: body.returnReason, package_contents: body.packageContents, estimated_boxes: 2, destination_warehouse_id: warehouse.id,
                preferred_day: body.preferredPickupDate, version: 0, route_batch_id: null,
            });
            expect(row.closed_at).toBeNull();
            expect(Number(row.delivery_latitude)).toBeCloseTo(-16.5421, 4);
        });

        it('deja un evento created_manually con el coordinador y el RMA solo como referencia', async () => {
            const res = await created(await validBody({ rmaId: 'RMA-2026-0043' }));

            const events = await eventsOf(res.body.id, 'created_manually');

            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({ actor_user_id: userIds.coordinator, actor_type: 'user' });
            expect(events[0].metadata).toMatchObject({ source: 'manual', rmaId: 'RMA-2026-0043', warehouseCode: warehouse.code });
        });

        it('el RMA mencionado no se usa como referencia: el recojo que llegue después de ese RMA no choca con el índice único', async () => {
            const res = await created(await validBody({ rmaId: `${prefix}-RMA-LATER` }));
            expect(res.body.sourceOrderRef).not.toContain('RMA-LATER');

            const id = await insert({ status: 'pickup_scheduled', origin: 'rma' });
            await dataSource.query(`UPDATE dispatches SET source_order_ref = $1 WHERE dispatch_id = $2`, [`${prefix}-RMA-LATER`, id]);

            expect((await dispatchRow(id)).source_order_ref).toBe(`${prefix}-RMA-LATER`);
        });

        it('acepta hoy (hora de Bolivia), sin campos opcionales', async () => {
            const { reference: _r, estimatedBoxes: _b, ...required } = await validBody({ preferredPickupDate: await day(0) });

            const res = await created(required);

            expect(res.body).toMatchObject({ reference: null, estimatedBoxes: null, preferredPickupDate: await day(0), status: 'pickup_scheduled' });
        });

        it('no publica nada al ERP: un recojo manual no existe para Almacén ni para Marketplace', async () => {
            const res = await created(await validBody());

            expect(await outboundCount(res.body.id)).toBe(0);
        });

        it('fecha anterior a hoy → 400 PICKUP_DATE_IN_PAST y no escribe nada', async () => {
            const before = await countByName();

            const res = await create(await validBody({ preferredPickupDate: await day(-1) }));

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('PICKUP_DATE_IN_PAST');
            expect(await countByName()).toBe(before);
        });

        it.each(['unknown', 'inactive'])('almacén %s → 422 WAREHOUSE_NOT_AVAILABLE y no escribe nada', async (kind) => {
            const before = await countByName();
            const warehouseCode = kind === 'unknown' ? 'WH-NO-EXISTE-99' : warehouse.inactiveCode;

            const res = await create(await validBody({ warehouseCode }));

            expect(res.status).toBe(422);
            expect(res.body.error).toBe('WAREHOUSE_NOT_AVAILABLE');
            expect(await countByName()).toBe(before);
        });

        it('almacén dado de baja (soft delete) → 422 WAREHOUSE_NOT_AVAILABLE', async () => {
            const [{ warehouse_id }] = await dataSource.query(
                `INSERT INTO warehouses (code, name, address, latitude, longitude, reception_start_time, reception_end_time, active, deleted_at)
                 VALUES ($1, $2, 'Almacén borrado E2E', -16.5, -68.1, '08:00', '17:00', TRUE, NOW()) RETURNING warehouse_id`,
                [`WH-D${run}`.slice(0, 30), `${prefix} Almacén borrado`],
            );
            expect(warehouse_id).toBeGreaterThan(0);

            const res = await create(await validBody({ warehouseCode: `WH-D${run}`.slice(0, 30) }));

            expect(res.status).toBe(422);
            expect(res.body.error).toBe('WAREHOUSE_NOT_AVAILABLE');
        });

        it.each([
            ['motivo vacío', { returnReason: '   ' }],
            ['motivo de más de 500 caracteres', { returnReason: 'x'.repeat(501) }],
            ['sin mercadería', { packageContents: '' }],
            ['teléfono inválido', { contactPhone: 'abc' }],
            ['latitud fuera de rango', { latitude: 91 }],
            ['sin coordenadas', { latitude: undefined, longitude: undefined }],
            ['fecha mal formada', { preferredPickupDate: '10/11/2026' }],
            ['cajas en cero', { estimatedBoxes: 0 }],
            ['franja horaria (no se elige aquí)', { windowStart: '2041-01-01T13:00:00Z' }],
            ['estado impuesto por el cliente', { status: 'assigned' }],
        ])('%s → 400 y no escribe nada', async (_name, extra) => {
            const before = await countByName();

            const res = await create(await validBody(extra));

            expect(res.status).toBe(400);
            expect(await countByName()).toBe(before);
        });
    });

    // ---------------------------------------------------------------------------------------------------------
    describe('PATCH /pickup-orders/:id/cancel', () => {
        it('sin token → 401; admin, supervisor y repartidor → 403', async () => {
            const id = await insert({ status: 'pickup_scheduled' });
            expect((await request(app.getHttpServer()).patch(url(`/${id}/cancel`)).send({ reason: 'x' })).status).toBe(401);
            for (const role of ['admin', 'supervisor', 'driver']) {
                expect((await cancel(id, { reason: 'x' }, role)).status, role).toBe(403);
            }
            expect((await dispatchRow(id)).status).toBe('pickup_scheduled');
        });

        it.each(['pickup_scheduled', 'address_review'])('%s sin lote: queda cancelled con closed_at, con su causal en el historial y sin publicar al ERP', async (status) => {
            const id = await insert({ status, coordinates: status === 'pickup_scheduled' });
            const before = await dispatchRow(id);

            const res = await cancel(id, { reason: 'El cliente desistió de la devolución' });

            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body).toMatchObject({ dispatchId: id, status: 'cancelled', previousStatus: status, routeBatchId: null, routeBatchClosed: false });
            const after = await dispatchRow(id);
            expect(after).toMatchObject({ status: 'cancelled', route_batch_id: null, version: before.version });
            expect(after.closed_at).not.toBeNull();
            expect(await outboundCount(id)).toBe(0);
            const events = await cancelEvents(id);
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({ actor_user_id: userIds.coordinator, actor_type: 'user', reason: 'El cliente desistió de la devolución' });
            expect(events[0].metadata).toMatchObject({ previousStatus: status, status: 'cancelled', reasonCode: 'COORD-CANCELLED' });
            expect(events[0].metadata).not.toHaveProperty('outboundRecordVersion');
        });

        it('in_planning en un lote provisional con otras paradas: sale del lote, sube la versión del recojo y la del lote y cierra el hueco', async () => {
            const batchId = await newBatch('provisional', { version: 3 });
            const first = await insert({ status: 'in_planning', batchId, sequence: 1 });
            const id = await insert({ status: 'in_planning', batchId, sequence: 2 });
            const last = await insert({ status: 'in_planning', batchId, sequence: 3 });
            const before = await dispatchRow(id);

            const res = await cancel(id);

            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body).toMatchObject({ status: 'cancelled', previousStatus: 'in_planning', routeBatchId: null, routeBatchClosed: false });
            const after = await dispatchRow(id);
            expect(after).toMatchObject({ status: 'cancelled', route_batch_id: null, sequence_order: null, version: before.version + 1 });
            expect(after.closed_at).not.toBeNull();
            expect(await batchRow(batchId)).toMatchObject({ status: 'provisional', version: 4 });
            expect((await dispatchRow(first)).sequence_order).toBe(1);
            expect((await dispatchRow(last)).sequence_order).toBe(2);
            expect(await outboundCount(id)).toBe(0);
            expect((await cancelEvents(id))[0].metadata).toMatchObject({ previousStatus: 'in_planning', routeBatchId: null, fromBatchId: batchId, version: after.version });
        });

        it('in_planning, última parada de un lote provisional: el lote queda cancelado', async () => {
            const batchId = await newBatch('provisional', { version: 1 });
            const id = await insert({ status: 'in_planning', batchId, sequence: 1 });

            const res = await cancel(id);

            expect(res.status).toBe(200);
            expect(await batchRow(batchId)).toMatchObject({ status: 'cancelled', version: 2 });
        });

        it.each(['assigned', 'scheduled', 'pending', 'in_transit', 'picked_up_in_transit', 'delivered', 'cancelled'])('%s → 409 DISPATCH_CANCEL_NOT_ALLOWED y no cambia nada', async (status) => {
            const id = await insert({ status });
            const before = await dispatchRow(id);

            const res = await cancel(id);

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('DISPATCH_CANCEL_NOT_ALLOWED');
            expect(res.body.message).toContain('pickup_scheduled, address_review or in_planning');
            expect(await dispatchRow(id)).toEqual(before);
        });

        it('cancelar dos veces → el segundo es 409', async () => {
            const id = await insert({ status: 'pickup_scheduled' });
            expect((await cancel(id)).status).toBe(200);

            const res = await cancel(id);

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('DISPATCH_CANCEL_NOT_ALLOWED');
            expect(await cancelEvents(id)).toHaveLength(1);
        });

        it('una entrega en este endpoint → 409 DISPATCH_TYPE_NOT_SUPPORTED y no cambia nada', async () => {
            const id = await insert({ status: 'pending', type: 'delivery' });
            const before = await dispatchRow(id);

            const res = await cancel(id);

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('DISPATCH_TYPE_NOT_SUPPORTED');
            expect(await dispatchRow(id)).toEqual(before);
        });

        it('un recojo en POST /dispatches/:id/cancel (entregas) → 409 DISPATCH_TYPE_NOT_SUPPORTED: cada endpoint solo cancela lo suyo', async () => {
            const id = await insert({ status: 'pickup_scheduled' });

            const res = await request(app.getHttpServer()).post(`/${apiPrefix}/dispatches/${id}/cancel`).set(auth('coordinator')).send({ reason: 'x' });

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('DISPATCH_TYPE_NOT_SUPPORTED');
            expect((await dispatchRow(id)).status).toBe('pickup_scheduled');
        });

        it('un id que no existe → 404; un id no numérico → 400; sin causal → 400 y no cambia nada', async () => {
            expect((await cancel(2_000_000_000)).status).toBe(404);
            expect((await cancel('abc')).status).toBe(400);
            const id = await insert({ status: 'pickup_scheduled' });
            expect((await cancel(id, {})).status).toBe(400);
            expect((await cancel(id, { reason: '   ' })).status).toBe(400);
            expect((await dispatchRow(id)).status).toBe('pickup_scheduled');
        });

        it('un recojo creado a mano se puede anular y aparece cancelado en el listado', async () => {
            const body = await validBody();
            const res = await created(body);

            expect((await cancel(res.body.id)).status).toBe(200);

            const listed = await list(`from=${body.preferredPickupDate}&to=${body.preferredPickupDate}&status=cancelled`);
            expect(listed.body.data.map((o: { id: number }) => o.id)).toEqual([res.body.id]);
        });
    });

    // ---------------------------------------------------------------------------------------------------------
    describe('GET /pickup-orders', () => {
        it('sin token → 401; admin y repartidor → 403; coordinador y supervisor → 200', async () => {
            expect((await request(app.getHttpServer()).get(url('')) ).status).toBe(401);
            for (const role of ['admin', 'driver']) expect((await list('', role)).status, role).toBe(403);
            for (const role of ['coordinator', 'supervisor']) expect((await list('limit=1', role)).status, role).toBe(200);
        });

        it('filtra por rango de fecha, estado y origen, y muestra cliente, dirección, motivo y almacén', async () => {
            const d1 = await isolatedDay();
            const d2 = await isolatedDay();
            const rmaScheduled = await insert({ status: 'pickup_scheduled', origin: 'rma', date: d1, name: `${prefix} Cliente RMA` });
            const rmaReview = await insert({ status: 'address_review', origin: 'rma', date: d1, coordinates: false });
            const manualScheduled = await insert({ status: 'pickup_scheduled', origin: 'manual', date: d2, name: `${prefix} Cliente manual` });
            const manualCancelled = await insert({ status: 'cancelled', origin: 'manual', date: d2 });
            const noDate = await insert({ status: 'pickup_scheduled', origin: 'rma', date: null });
            const delivery = await insert({ status: 'pending', type: 'delivery', date: d1 });
            const ids = (res: request.Response): number[] => res.body.data.map((o: { id: number }) => o.id).sort((a: number, b: number) => a - b);

            const all = await list(`from=${d1}&to=${d2}`);
            expect(all.status, JSON.stringify(all.body)).toBe(200);
            expect(ids(all)).toEqual([rmaScheduled, rmaReview, manualScheduled, manualCancelled].sort((a, b) => a - b));
            expect(all.body.meta).toEqual({ page: 1, limit: 10, total: 4, pages: 1 });
            expect(ids(all)).not.toContain(noDate); // sin fecha preferida: queda fuera cuando se filtra por fecha
            expect(ids(all)).not.toContain(delivery); // una entrega no es un recojo

            expect(ids(await list(`from=${d1}&to=${d1}`))).toEqual([rmaScheduled, rmaReview].sort((a, b) => a - b));
            expect(ids(await list(`from=${d2}&to=${d2}`))).toEqual([manualScheduled, manualCancelled].sort((a, b) => a - b));
            expect(ids(await list(`from=${d1}&to=${d2}&origin=manual`))).toEqual([manualScheduled, manualCancelled].sort((a, b) => a - b));
            expect(ids(await list(`from=${d1}&to=${d2}&origin=rma`))).toEqual([rmaScheduled, rmaReview].sort((a, b) => a - b));
            expect(ids(await list(`from=${d1}&to=${d2}&status=cancelled`))).toEqual([manualCancelled]);
            expect(ids(await list(`from=${d1}&to=${d2}&status=pickup_scheduled&origin=rma`))).toEqual([rmaScheduled]);
            expect(ids(await list(`from=${d1}&to=${d2}&status=address_review`))).toEqual([rmaReview]);
            expect(ids(await list(`from=${d1}&to=${d2}&status=in_planning`))).toEqual([]);

            const rma = all.body.data.find((o: { id: number }) => o.id === rmaScheduled);
            expect(rma).toMatchObject({
                origin: 'rma', status: 'pickup_scheduled', contactName: `${prefix} Cliente RMA`, address: 'Dirección E2E ST-81.2',
                returnReason: 'Motivo E2E', preferredPickupDate: d1, destinationWarehouse: { id: warehouse.id, code: warehouse.code },
            });
            const review = all.body.data.find((o: { id: number }) => o.id === rmaReview);
            expect(review).toMatchObject({ status: 'address_review', latitude: null, longitude: null });
            expect(all.body.data.find((o: { id: number }) => o.id === manualScheduled)).toMatchObject({ origin: 'manual' });
        });

        it('el supervisor ve lo mismo que el coordinador', async () => {
            const d = await isolatedDay();
            const id = await insert({ status: 'pickup_scheduled', origin: 'rma', date: d });

            const res = await list(`from=${d}&to=${d}`, 'supervisor');

            expect(res.body.data.map((o: { id: number }) => o.id)).toEqual([id]);
        });

        it('un recojo creado por el POST se lista como manual', async () => {
            const body = await validBody();
            const res = await created(body);

            const listed = await list(`from=${body.preferredPickupDate}&to=${body.preferredPickupDate}&origin=manual`);

            expect(listed.body.data).toHaveLength(1);
            expect(listed.body.data[0]).toMatchObject({ id: res.body.id, origin: 'manual', sourceOrderRef: res.body.sourceOrderRef });
        });

        it('pagina: los más nuevos primero, con el total y las páginas', async () => {
            const d = await isolatedDay();
            const ids: number[] = [];
            for (let i = 0; i < 5; i++) ids.push(await insert({ status: 'pickup_scheduled', origin: 'rma', date: d }));

            const page1 = await list(`from=${d}&to=${d}&limit=2&page=1`);
            const page3 = await list(`from=${d}&to=${d}&limit=2&page=3`);
            const beyond = await list(`from=${d}&to=${d}&limit=2&page=4`);

            expect(page1.body.meta).toEqual({ page: 1, limit: 2, total: 5, pages: 3 });
            expect(page1.body.data.map((o: { id: number }) => o.id)).toEqual([ids[4], ids[3]]);
            expect(page3.body.data.map((o: { id: number }) => o.id)).toEqual([ids[0]]);
            expect(beyond.body.data).toEqual([]);
        });

        it('un rango sin datos devuelve la lista vacía', async () => {
            const d = await isolatedDay();

            const res = await list(`from=${d}&to=${d}`);

            expect(res.body).toEqual({ data: [], meta: { page: 1, limit: 10, total: 0, pages: 0 } });
        });

        it.each([
            ['origen desconocido', 'origin=otro'],
            ['estado inexistente', 'status=volando'],
            ['fecha mal formada', 'from=01-11-2026'],
            ['fecha imposible', 'to=2026-02-30'],
            ['rango invertido', 'from=2026-11-10&to=2026-11-09'],
            ['límite excesivo', 'limit=101'],
            ['página cero', 'page=0'],
            ['parámetro desconocido', 'search=algo'],
        ])('%s → 400', async (_name, query) => {
            const res = await list(query);

            expect(res.status).toBe(400);
        });

        it('un rango invertido responde con su propio código', async () => {
            const res = await list('from=2026-11-10&to=2026-11-09');

            expect(res.body.error).toBe('INVALID_PICKUP_DATE_RANGE');
        });

        it('los filtros vacíos (un select en blanco de la página) no filtran', async () => {
            const res = await list('status=&origin=&from=&to=&limit=1');

            expect(res.status).toBe(200);
        });
    });
});
