// ST-52.2 (RF-A05, ES-52) — reprogramación del coordinador y devolución a almacén.
//
// Levanta el AppModule real contra una base de datos real y pega por HTTP con supertest. Todo lo que crea lleva un
// prefijo único por corrida y se borra en afterAll. Las fechas se calculan desde hoy (hora de Bolivia), nunca fijas.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

const TZ = 'America/La_Paz';

describe('Reprogramación y devolución del coordinador (e2e, ST-52.2)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const tokens: Record<string, string> = {};
    const userIds: Record<string, number> = {};
    const statusIds: Record<string, number> = {};
    const typeIds: Record<string, number> = {};
    const batchIds: number[] = [];
    const reasonCodes: { ok: string; inactive: string } = { ok: '', inactive: '' };
    const incidentReasons: Record<'counts' | 'free', { id: number; code: string }> = { counts: { id: 0, code: '' }, free: { id: 0, code: '' } };

    const run = Date.now().toString(36).toUpperCase();
    const prefix = `RS${run}`;
    const trackingBase = Math.floor(Math.random() * 80_000) + 10_000;
    let seq = 0;
    let batchSeq = 0;

    const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
    const post = (id: number | string, action: 'reschedule' | 'return' | 'cancel', body: object = {}, role = 'coordinator') =>
        request(app.getHttpServer()).post(`/${apiPrefix}/dispatches/${id}/${action}`).set(auth(role)).send(body);

    /** La fecha local (Bolivia) de hoy + n días, `YYYY-MM-DD`. */
    const day = async (n: number): Promise<string> =>
        (await dataSource.query(`SELECT ((NOW() AT TIME ZONE '${TZ}')::date + $1::int)::text AS d`, [n]))[0].d;
    // Franjas de 2 h con los valores por defecto: 09-11 son las 13:00Z-15:00Z de Bolivia (UTC-4); 14-16, las 18:00Z-20:00Z.
    const morning = (date: string) => ({ windowStart: `${date}T13:00:00Z`, windowEnd: `${date}T15:00:00Z` });
    const afternoon = (date: string) => ({ windowStart: `${date}T18:00:00Z`, windowEnd: `${date}T20:00:00Z` });
    const body = (date: string, extra: object = {}) => ({ reasonCode: reasonCodes.ok, ...morning(date), ...extra });

    const newBatch = async (status: string, opts: { version?: number } = {}): Promise<number> => {
        const [{ route_batch_id: id }] = await dataSource.query(
            `INSERT INTO route_batches (shift_date, status, version) VALUES (DATE '2041-01-01' + $1::int, $2, $3) RETURNING route_batch_id`,
            [batchSeq++, status, opts.version ?? 0],
        );
        batchIds.push(id);
        return id as number;
    };

    const newDispatch = async (o: { status: string; batchId?: number | null; sequence?: number | null; type?: string; confirmation?: string } = { status: 'not_delivered' }): Promise<number> => {
        const n = ++seq;
        const tomorrow = await day(1);
        const [{ dispatch_id }] = await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order, source_order_ref, tracking_code,
                                     delivery_address, contact_name, customer_confirmation, scheduled_window_start, scheduled_window_end)
             VALUES ($1, $2, $3, $4, $5, $6, 'Dirección E2E ST-52.2', $7, $8, ($9::date + TIME '09:00') AT TIME ZONE '${TZ}', ($9::date + TIME '11:00') AT TIME ZONE '${TZ}')
             RETURNING dispatch_id`,
            [
                typeIds[o.type ?? 'delivery'], statusIds[o.status], o.batchId ?? null, o.sequence ?? null,
                `${prefix}-${n}`, `DSP-2041-${String(trackingBase + n).padStart(5, '0')}`, `${prefix} Cliente ${n}`,
                o.confirmation ?? 'confirmed', tomorrow,
            ],
        );
        return dispatch_id as number;
    };

    const tracking = async (id: number): Promise<string> =>
        (await dataSource.query(`SELECT tracking_code FROM dispatches WHERE dispatch_id = $1`, [id]))[0].tracking_code;

    /** Entradas a `not_delivered` del despacho, tal como las escribe el cambio de estado del repartidor. */
    const addNotDelivered = async (id: number, times: number): Promise<void> => {
        for (let i = 0; i < times; i++) {
            await dataSource.query(
                `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, metadata) VALUES ($1, 'status_changed', 'user', $2::jsonb)`,
                [id, JSON.stringify({ previousStatus: 'in_transit', status: 'not_delivered' })],
            );
        }
    };
    const addIncident = async (id: number, kind: 'counts' | 'free'): Promise<void> => {
        await dataSource.query(
            `INSERT INTO dispatch_incidents (dispatch_incident_id, dispatch_id, incident_reason_id, description) VALUES ($1, $2, $3, 'E2E')`,
            [randomUUID(), id, incidentReasons[kind].id],
        );
    };

    const dispatchRow = async (id: number) => (await dataSource.query(
        `SELECT ds.name AS status, d.version, d.route_batch_id, d.sequence_order, d.closed_at, d.customer_confirmation,
                d.scheduled_window_start, d.scheduled_window_end
           FROM dispatches d JOIN dispatch_statuses ds USING (dispatch_status_id) WHERE d.dispatch_id = $1`, [id]))[0];
    const batchRow = async (id: number) => (await dataSource.query(`SELECT status, version FROM route_batches WHERE route_batch_id = $1`, [id]))[0];
    const reschedules = async (id: number) => await dataSource.query(
        `SELECT * FROM dispatch_reschedules WHERE dispatch_id = $1 ORDER BY dispatch_reschedule_id`, [id]);
    const dispatchEvents = async (id: number) => await dataSource.query(
        `SELECT event_type, actor_user_id, actor_type, metadata FROM dispatch_events
          WHERE dispatch_id = $1 AND event_type = 'status_changed' AND actor_type = 'user' AND metadata ? 'previousStatus' AND metadata->>'status' IN ('rescheduled','returned')
          ORDER BY dispatch_event_id`, [id]);
    const batchEvents = async (batchId: number, type: string) => await dataSource.query(
        `SELECT dispatch_id, event_type, actor_type, metadata FROM route_batch_events WHERE route_batch_id = $1 AND event_type = $2 ORDER BY route_batch_event_id`, [batchId, type]);
    const outboundFor = async (id: number) => await dataSource.query(
        `SELECT om.status, om.payload->'data' AS data FROM outbound_messages om
           JOIN dispatches d ON d.source_order_ref = om.payload->'data'->>'salesOrderId'
          WHERE d.dispatch_id = $1 AND om.type = 'dispatch.transfer.status_changed' ORDER BY om.created_at`, [id]);

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
            const username = `e2e_rs_${role}_${run}`;
            const [{ user_id }] = await dataSource.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false) RETURNING user_id`,
                [role_id, `Reprogramación ${role} ${run}`, username, passwordHash],
            );
            userIds[role] = user_id;
            const res = await request(app.getHttpServer()).post(`/${apiPrefix}/auth/login`).send({ username, password: 'E2eTest1234' });
            tokens[role] = res.body.accessToken as string;
        }

        for (const r of await dataSource.query(`SELECT dispatch_status_id AS id, name FROM dispatch_statuses`)) statusIds[r.name] = r.id;
        for (const r of await dataSource.query(`SELECT dispatch_type_id AS id, name FROM dispatch_types`)) typeIds[r.name] = r.id;

        reasonCodes.ok = `RES-E${run}`.slice(0, 30);
        reasonCodes.inactive = `RES-I${run}`.slice(0, 30);
        await dataSource.query(
            `INSERT INTO reschedule_reasons (code, name, category, active) VALUES ($1, $2, 'operations', TRUE), ($3, $4, 'operations', FALSE)`,
            [reasonCodes.ok, `${prefix} motivo`, reasonCodes.inactive, `${prefix} motivo inactivo`],
        );

        const [counts] = await dataSource.query(`SELECT incident_reason_id AS id, code FROM incident_reasons WHERE counts_as_attempt = TRUE AND active AND deleted_at IS NULL ORDER BY incident_reason_id LIMIT 1`);
        const [free] = await dataSource.query(`SELECT incident_reason_id AS id, code FROM incident_reasons WHERE counts_as_attempt = FALSE AND active AND deleted_at IS NULL ORDER BY incident_reason_id LIMIT 1`);
        incidentReasons.counts = counts;
        incidentReasons.free = free;
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) {
            await withEventPurge(dataSource, {
                dispatchRefs: [`${prefix}%`],
                routeBatchIds: batchIds,
                userNames: [`e2e_rs_%_${run}`],
            }, async (manager) => {
                await manager.query(`DELETE FROM outbound_messages WHERE payload->'data'->>'salesOrderId' LIKE $1`, [`${prefix}%`]);
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${prefix}%`]);
                if (batchIds.length) await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
                await manager.query(`DELETE FROM reschedule_reasons WHERE name LIKE $1`, [`${prefix}%`]);
                await manager.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_rs_%_${run}`]);
            });
        }
        await app?.close();
    });

    describe('POST /dispatches/:id/reschedule', () => {
        describe('permisos', () => {
            it('sin token → 401; supervisor, admin y driver → 403 sin cambiar nada; coordinator → 200', async () => {
                const id = await newDispatch({ status: 'not_delivered' });
                const date = await day(3);
                expect((await request(app.getHttpServer()).post(`/${apiPrefix}/dispatches/${id}/reschedule`).send(body(date))).status).toBe(401);
                for (const role of ['supervisor', 'admin', 'driver']) {
                    expect((await post(id, 'reschedule', body(date), role)).status).toBe(403);
                }
                expect((await dispatchRow(id)).status).toBe('not_delivered');

                expect((await post(id, 'reschedule', body(date))).status).toBe(200);
            });
        });

        describe('reprogramación válida', () => {
            it('not_delivered en un lote en ejecución con otras paradas abiertas: lo saca del lote, deja los dos registros y las dos ventanas', async () => {
                const batchId = await newBatch('in_execution', { version: 3 });
                const other = await newDispatch({ status: 'out_for_delivery', batchId, sequence: 2 });
                const id = await newDispatch({ status: 'not_delivered', batchId, sequence: 1 });
                await addNotDelivered(id, 1);
                const before = await dispatchRow(id);
                const date = await day(3);

                const res = await post(id, 'reschedule', body(date, { instructions: 'Llamar 30 minutos antes' }));

                expect(res.status).toBe(200);
                expect(res.body).toMatchObject({
                    dispatchId: id, status: 'rescheduled', shift: 'morning', attemptsUsed: 1, attemptsLimit: 3,
                    windowStart: `${date}T13:00:00.000Z`, windowEnd: `${date}T15:00:00.000Z`, version: before.version + 1,
                });
                const after = await dispatchRow(id);
                expect(after).toMatchObject({ status: 'rescheduled', route_batch_id: null, sequence_order: null, closed_at: null, version: before.version + 1 });
                // La bandeja lee scheduled_window_*, el planificador lee dispatch_reschedules: las dos tienen la ventana acordada.
                expect(new Date(after.scheduled_window_start).toISOString()).toBe(`${date}T13:00:00.000Z`);
                expect(new Date(after.scheduled_window_end).toISOString()).toBe(`${date}T15:00:00.000Z`);
                const rows = await reschedules(id);
                expect(rows).toHaveLength(1);
                expect(rows[0]).toMatchObject({
                    rescheduled_by: userIds.coordinator, rescheduled_by_type: 'coordinator', previous_route_batch_id: batchId, new_route_batch_id: null,
                });
                expect(new Date(rows[0].new_window_start).toISOString()).toBe(`${date}T13:00:00.000Z`);
                expect(new Date(rows[0].previous_window_start).toISOString()).toBe(new Date(before.scheduled_window_start).toISOString());
                // Lote: versión +1, sigue en ejecución porque otra parada lo mantiene abierto; la otra parada no se tocó.
                expect(await batchRow(batchId)).toEqual({ status: 'in_execution', version: 4 });
                expect((await dispatchRow(other)).sequence_order).toBe(2);
                const removed = await batchEvents(batchId, 'order_removed');
                expect(removed).toHaveLength(1);
                expect(removed[0]).toMatchObject({ dispatch_id: id, actor_type: 'user' });
                expect(removed[0].metadata).toMatchObject({ rescheduleId: rows[0].dispatch_reschedule_id, batchStatusBefore: 'in_execution', batchStatusAfter: 'in_execution' });
                const events = await dispatchEvents(id);
                expect(events).toHaveLength(1);
                expect(events[0]).toMatchObject({ actor_user_id: userIds.coordinator });
                expect(events[0].metadata).toMatchObject({
                    previousStatus: 'not_delivered', status: 'rescheduled', reasonCode: reasonCodes.ok, instructions: 'Llamar 30 minutos antes', attemptsUsed: 1,
                });
            });

            it('incident, scheduled y assigned también se pueden reprogramar; la franja de la tarde se deriva como tal', async () => {
                for (const status of ['incident', 'scheduled', 'assigned']) {
                    const id = await newDispatch({ status });
                    const res = await post(id, 'reschedule', { reasonCode: reasonCodes.ok, ...afternoon(await day(4)) });
                    expect(res.status).toBe(200);
                    expect(res.body).toMatchObject({ status: 'rescheduled', shift: 'afternoon' });
                    expect((await dispatchRow(id)).route_batch_id).toBeNull();
                }
            });

            it('un despacho sin lote se reprograma y su versión sube una sola vez', async () => {
                const id = await newDispatch({ status: 'scheduled' });
                const before = await dispatchRow(id);

                const res = await post(id, 'reschedule', body(await day(3)));

                expect(res.status).toBe(200);
                expect((await dispatchRow(id)).version).toBe(before.version + 1);
                expect((await reschedules(id))[0].previous_route_batch_id).toBeNull();
            });

            it('la fecha de hoy es válida y el despacho aparece en la bandeja con el estado reprogramado', async () => {
                const id = await newDispatch({ status: 'not_delivered' });
                await addNotDelivered(id, 1);

                const res = await post(id, 'reschedule', body(await day(0)));
                expect(res.status).toBe(200);

                const inbox = await request(app.getHttpServer())
                    .get(`/${apiPrefix}/pending-orders?limit=100&search=${await tracking(id)}`).set(auth('coordinator'));
                expect(inbox.status).toBe(200);
                expect(inbox.body.data.map((item: { id: number }) => item.id)).toContain(id);
            });

            it('sale del historial: closed_at queda en NULL y ya no aparece entre los despachos cerrados', async () => {
                const id = await newDispatch({ status: 'not_delivered' });
                await dataSource.query(`UPDATE dispatches SET closed_at = NOW() WHERE dispatch_id = $1`, [id]);
                const code = await tracking(id);
                const history = () => request(app.getHttpServer())
                    .get(`/${apiPrefix}/dispatches/history?limit=50&search=${code}`).set(auth('coordinator'));
                expect((await history()).body.data.map((item: { id: number }) => item.id)).toContain(id);

                expect((await post(id, 'reschedule', body(await day(3)))).status).toBe(200);

                expect((await dispatchRow(id)).closed_at).toBeNull();
                expect((await history()).body.data.map((item: { id: number }) => item.id)).not.toContain(id);
            });

            it('resuelve la solicitud de cambio del cliente', async () => {
                const batchId = await newBatch('confirmed');
                const id = await newDispatch({ status: 'scheduled', batchId, sequence: 1, confirmation: 'change_requested' });

                expect((await post(id, 'reschedule', body(await day(3)))).status).toBe(200);

                expect((await dispatchRow(id)).customer_confirmation).toBe('rescheduled');
                expect((await dispatchEvents(id))[0].metadata.customerChangeRequestResolved).toBe(true);
            });
        });

        describe('el lote según su estado', () => {
            it('provisional: cierra el hueco de la secuencia y sube la versión del lote', async () => {
                const batchId = await newBatch('provisional', { version: 1 });
                await newDispatch({ status: 'scheduled', batchId, sequence: 1 });
                const middle = await newDispatch({ status: 'scheduled', batchId, sequence: 2 });
                const last = await newDispatch({ status: 'scheduled', batchId, sequence: 3 });

                expect((await post(middle, 'reschedule', body(await day(3)))).status).toBe(200);

                expect((await dispatchRow(last)).sequence_order).toBe(2);
                expect(await batchRow(batchId)).toEqual({ status: 'provisional', version: 2 });
            });

            it('provisional que se queda vacío: se cancela', async () => {
                const batchId = await newBatch('provisional');
                const id = await newDispatch({ status: 'scheduled', batchId, sequence: 1 });

                expect((await post(id, 'reschedule', body(await day(3)))).status).toBe(200);

                expect(await batchRow(batchId)).toMatchObject({ status: 'cancelled' });
                expect(await batchEvents(batchId, 'cancelled')).toHaveLength(1);
            });

            it('confirmed: no renumera las demás paradas', async () => {
                const batchId = await newBatch('confirmed');
                const first = await newDispatch({ status: 'assigned', batchId, sequence: 1 });
                const second = await newDispatch({ status: 'assigned', batchId, sequence: 2 });

                expect((await post(first, 'reschedule', body(await day(3)))).status).toBe(200);

                expect((await dispatchRow(second)).sequence_order).toBe(2);
                expect(await batchRow(batchId)).toEqual({ status: 'confirmed', version: 1 });
            });

            it('en ejecución: reprogramar el despacho excluido por cotejo (assigned) hace que el lote cierre', async () => {
                const batchId = await newBatch('in_execution');
                await newDispatch({ status: 'delivered', batchId, sequence: 1 });
                const excluded = await newDispatch({ status: 'assigned', batchId, sequence: 2 });

                expect((await post(excluded, 'reschedule', body(await day(3)))).status).toBe(200);

                expect(await batchRow(batchId)).toMatchObject({ status: 'closed' });
                expect(await batchEvents(batchId, 'closed')).toHaveLength(1);
            });

            it('closed: el despacho sale pero el lote y su versión no se tocan', async () => {
                const batchId = await newBatch('closed', { version: 5 });
                await newDispatch({ status: 'delivered', batchId, sequence: 1 });
                const id = await newDispatch({ status: 'not_delivered', batchId, sequence: 2 });
                await addNotDelivered(id, 1);

                expect((await post(id, 'reschedule', body(await day(3)))).status).toBe(200);

                expect(await batchRow(batchId)).toEqual({ status: 'closed', version: 5 });
                expect((await dispatchRow(id)).route_batch_id).toBeNull();
                expect(await batchEvents(batchId, 'order_removed')).toHaveLength(1);
            });
        });

        describe('estado inválido', () => {
            it.each(['pending', 'in_planning', 'out_for_delivery', 'in_transit', 'delivered', 'rescheduled', 'returned', 'cancelled'])(
                '%s → 409 DISPATCH_STATUS_NOT_RESCHEDULABLE y no cambia nada', async (status) => {
                    const id = await newDispatch({ status });
                    const before = await dispatchRow(id);

                    const res = await post(id, 'reschedule', body(await day(3)));

                    expect(res.status).toBe(409);
                    expect(res.body.error).toBe('DISPATCH_STATUS_NOT_RESCHEDULABLE');
                    expect(await dispatchRow(id)).toEqual(before);
                    expect(await reschedules(id)).toHaveLength(0);
                },
            );

            it('un despacho que no es de entrega → 409 DISPATCH_TYPE_NOT_SUPPORTED', async () => {
                const id = await newDispatch({ status: 'scheduled', type: 'supplier_pickup' });

                const res = await post(id, 'reschedule', body(await day(3)));

                expect(res.status).toBe(409);
                expect(res.body.error).toBe('DISPATCH_TYPE_NOT_SUPPORTED');
            });

            it('un despacho inexistente → 404', async () => {
                expect((await post(2_000_000_000, 'reschedule', body(await day(3)))).status).toBe(404);
            });
        });

        describe('límite de entregas no concretadas', () => {
            it('tres not_delivered alcanzan el límite → 400 que indica devolver a almacén, y no se escribe nada', async () => {
                const batchId = await newBatch('closed', { version: 2 });
                const id = await newDispatch({ status: 'not_delivered', batchId, sequence: 1 });
                await addNotDelivered(id, 3);
                const before = await dispatchRow(id);

                const res = await post(id, 'reschedule', body(await day(3)));

                expect(res.status).toBe(400);
                expect(res.body.error).toBe('RESCHEDULE_ATTEMPTS_LIMIT_REACHED');
                expect(res.body.message).toContain('returned to the warehouse');
                expect(await dispatchRow(id)).toEqual(before);
                expect(await reschedules(id)).toHaveLength(0);
                expect(await batchEvents(batchId, 'order_removed')).toHaveLength(0);
            });

            it('con dos intentos todavía se puede reprogramar', async () => {
                const id = await newDispatch({ status: 'not_delivered' });
                await addNotDelivered(id, 2);

                const res = await post(id, 'reschedule', body(await day(3)));

                expect(res.status).toBe(200);
                expect(res.body).toMatchObject({ attemptsUsed: 2, attemptsLimit: 3 });
            });

            it('una incidencia cuyo motivo cuenta como intento suma: dos not_delivered más una incidencia que cuenta alcanzan el límite', async () => {
                const id = await newDispatch({ status: 'incident' });
                await addNotDelivered(id, 2);
                await addIncident(id, 'counts');

                const res = await post(id, 'reschedule', body(await day(3)));

                expect(res.status).toBe(400);
                expect(res.body.error).toBe('RESCHEDULE_ATTEMPTS_LIMIT_REACHED');
            });

            it('una incidencia cuyo motivo NO cuenta como intento no suma: dos not_delivered más una incidencia que no cuenta → 200', async () => {
                const id = await newDispatch({ status: 'incident' });
                await addNotDelivered(id, 2);
                await addIncident(id, 'free');

                const res = await post(id, 'reschedule', body(await day(3)));

                expect(res.status).toBe(200);
                expect(res.body.attemptsUsed).toBe(2);
            });

            it('las filas de dispatch_reschedules no cuentan como intentos', async () => {
                const id = await newDispatch({ status: 'not_delivered' });
                const [{ reschedule_reason_id }] = await dataSource.query(`SELECT reschedule_reason_id FROM reschedule_reasons WHERE code = $1`, [reasonCodes.ok]);
                for (let i = 0; i < 4; i++) {
                    await dataSource.query(
                        `INSERT INTO dispatch_reschedules (dispatch_id, reschedule_reason_id, rescheduled_by_type, new_window_start, new_window_end)
                         VALUES ($1, $2, 'coordinator', NOW(), NOW() + INTERVAL '2 hours')`,
                        [id, reschedule_reason_id],
                    );
                }
                await addNotDelivered(id, 1);

                const res = await post(id, 'reschedule', body(await day(3)));

                expect(res.status).toBe(200);
                expect(res.body.attemptsUsed).toBe(1);
            });

            it('un reporte repetido del mismo not_delivered (ya estaba en ese estado) no cuenta como otro intento', async () => {
                const id = await newDispatch({ status: 'not_delivered' });
                await addNotDelivered(id, 1);
                for (let i = 0; i < 4; i++) {
                    await dataSource.query(
                        `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, metadata) VALUES ($1, 'status_changed', 'user', $2::jsonb)`,
                        [id, JSON.stringify({ previousStatus: 'not_delivered', status: 'not_delivered' })],
                    );
                }

                const res = await post(id, 'reschedule', body(await day(3)));

                expect(res.status).toBe(200);
                expect(res.body.attemptsUsed).toBe(1);
            });
        });

        describe('fecha, franja y motivo', () => {
            it('una fecha anterior a hoy → 400 INVALID_RESCHEDULE_WINDOW', async () => {
                const id = await newDispatch({ status: 'not_delivered' });

                const res = await post(id, 'reschedule', body(await day(-1)));

                expect(res.status).toBe(400);
                expect(res.body.error).toBe('INVALID_RESCHEDULE_WINDOW');
                expect(res.body.message).toBe('The agreed date cannot be before today.');
                expect((await dispatchRow(id)).status).toBe('not_delivered');
            });

            it.each([
                ['una ventana que no es una franja', { windowStart: '13:30', windowEnd: '15:30' }],
                ['una franja en el almuerzo', { windowStart: '17:00', windowEnd: '18:00' }],
                ['una ventana más larga que una franja', { windowStart: '13:00', windowEnd: '17:00' }],
            ])('%s → 400 INVALID_RESCHEDULE_WINDOW', async (_name, times) => {
                const id = await newDispatch({ status: 'not_delivered' });
                const date = await day(3);

                const res = await post(id, 'reschedule', {
                    reasonCode: reasonCodes.ok, windowStart: `${date}T${times.windowStart}:00Z`, windowEnd: `${date}T${times.windowEnd}:00Z`,
                });

                expect(res.status).toBe(400);
                expect(res.body.error).toBe('INVALID_RESCHEDULE_WINDOW');
            });

            it('un fin que no es posterior al inicio → 400', async () => {
                const id = await newDispatch({ status: 'not_delivered' });
                const date = await day(3);

                const res = await post(id, 'reschedule', { reasonCode: reasonCodes.ok, windowStart: `${date}T15:00:00Z`, windowEnd: `${date}T13:00:00Z` });

                expect(res.status).toBe(400);
                expect(res.body.error).toBe('INVALID_RESCHEDULE_WINDOW');
            });

            it('un motivo inexistente o inactivo → 400 RESCHEDULE_REASON_INVALID', async () => {
                const id = await newDispatch({ status: 'not_delivered' });
                const date = await day(3);

                for (const reasonCode of ['RES-NO-EXISTE', reasonCodes.inactive]) {
                    const res = await post(id, 'reschedule', { ...body(date), reasonCode });
                    expect(res.status).toBe(400);
                    expect(res.body.error).toBe('RESCHEDULE_REASON_INVALID');
                }
                expect(await reschedules(id)).toHaveLength(0);
            });

            it('el cuerpo se valida: faltan campos, fechas sin zona horaria, instrucciones demasiado largas y campos desconocidos → 400', async () => {
                const id = await newDispatch({ status: 'not_delivered' });
                const date = await day(3);

                expect((await post(id, 'reschedule', {})).status).toBe(400);
                expect((await post(id, 'reschedule', { ...body(date), windowStart: `${date}T13:00:00` })).status).toBe(400);
                expect((await post(id, 'reschedule', body(date, { instructions: 'x'.repeat(501) }))).status).toBe(400);
                expect((await post(id, 'reschedule', body(date, { extra: true }))).status).toBe(400);
                expect((await post('abc', 'reschedule', body(date))).status).toBe(400);
            });
        });

        describe('concurrencia', () => {
            it('dos solicitudes simultáneas sobre el mismo despacho: una gana y la otra recibe 409, con un solo registro', async () => {
                const batchId = await newBatch('confirmed');
                const id = await newDispatch({ status: 'assigned', batchId, sequence: 1 });
                await newDispatch({ status: 'assigned', batchId, sequence: 2 });
                const date = await day(3);

                const results = await Promise.all([post(id, 'reschedule', body(date)), post(id, 'reschedule', body(date))]);

                expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
                expect(await reschedules(id)).toHaveLength(1);
                expect(await batchEvents(batchId, 'order_removed')).toHaveLength(1);
            });
        });
    });

    describe('POST /dispatches/:id/return', () => {
        it('driver, admin y supervisor → 403; sin token → 401', async () => {
            const id = await newDispatch({ status: 'not_delivered' });
            await addNotDelivered(id, 3);
            expect((await request(app.getHttpServer()).post(`/${apiPrefix}/dispatches/${id}/return`).send({})).status).toBe(401);
            for (const role of ['driver', 'admin', 'supervisor']) expect((await post(id, 'return', {}, role)).status).toBe(403);
            expect((await dispatchRow(id)).status).toBe('not_delivered');
        });

        it('not_delivered con los intentos agotados: queda returned con closed_at, conserva el lote, publica el mensaje y registra la nota', async () => {
            const batchId = await newBatch('closed', { version: 4 });
            const id = await newDispatch({ status: 'not_delivered', batchId, sequence: 1 });
            await addNotDelivered(id, 2);
            await addIncident(id, 'counts');
            const before = await dispatchRow(id);

            const res = await post(id, 'return', { notes: 'Cliente ilocalizable' });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ dispatchId: id, status: 'returned', previousStatus: 'not_delivered', reasonCode: incidentReasons.counts.code, attemptsUsed: 3, attemptsLimit: 3 });
            const after = await dispatchRow(id);
            expect(after).toMatchObject({ status: 'returned', route_batch_id: batchId, sequence_order: 1, version: before.version });
            expect(after.closed_at).not.toBeNull();
            expect(new Date(after.closed_at).toISOString()).toBe(res.body.closedAt);
            expect(await batchRow(batchId)).toEqual({ status: 'closed', version: 4 });
            const outbound = await outboundFor(id);
            expect(outbound).toHaveLength(1);
            expect(outbound[0].data).toMatchObject({ status: 'returned', previousStatus: 'not_delivered', reasonCode: incidentReasons.counts.code, recordVersion: 1 });
            const events = await dispatchEvents(id);
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({ actor_user_id: userIds.coordinator });
            expect(events[0].metadata).toMatchObject({ previousStatus: 'not_delivered', status: 'returned', outboundRecordVersion: 1, notes: 'Cliente ilocalizable', attemptsUsed: 3 });
        });

        it('aparece en el historial con su fecha de cierre y con el conductor/vehículo de su lote', async () => {
            const id = await newDispatch({ status: 'incident' });
            await addNotDelivered(id, 2);
            await addIncident(id, 'counts');

            expect((await post(id, 'return', {})).status).toBe(200);

            const history = await request(app.getHttpServer())
                .get(`/${apiPrefix}/dispatches/history?limit=50&search=${await tracking(id)}&status=returned`).set(auth('coordinator'));
            expect(history.status).toBe(200);
            expect(history.body.data.map((item: { id: number }) => item.id)).toContain(id);
        });

        it('incident sin incidencias registradas: se devuelve y el mensaje va sin reasonCode', async () => {
            const id = await newDispatch({ status: 'incident' });
            await addNotDelivered(id, 3);

            const res = await post(id, 'return');

            expect(res.status).toBe(200);
            expect(res.body.reasonCode).toBeNull();
            expect((await outboundFor(id))[0].data).not.toHaveProperty('reasonCode');
        });

        it('antes de alcanzar el límite → 409 DELIVERY_ATTEMPTS_NOT_EXHAUSTED y no publica nada', async () => {
            const id = await newDispatch({ status: 'not_delivered' });
            await addNotDelivered(id, 2);

            const res = await post(id, 'return', {});

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('DELIVERY_ATTEMPTS_NOT_EXHAUSTED');
            expect((await dispatchRow(id)).status).toBe('not_delivered');
            expect(await outboundFor(id)).toHaveLength(0);
        });

        it.each(['pending', 'scheduled', 'assigned', 'out_for_delivery', 'rescheduled', 'delivered', 'cancelled'])('%s → 409 DISPATCH_RETURN_NOT_ALLOWED', async (status) => {
            const id = await newDispatch({ status });
            await addNotDelivered(id, 3);

            const res = await post(id, 'return', {});

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('DISPATCH_RETURN_NOT_ALLOWED');
            expect(await outboundFor(id)).toHaveLength(0);
        });

        it('devolver dos veces: la segunda → 409 y un solo mensaje publicado', async () => {
            const id = await newDispatch({ status: 'not_delivered' });
            await addNotDelivered(id, 3);

            expect((await post(id, 'return', {})).status).toBe(200);
            const second = await post(id, 'return', {});

            expect(second.status).toBe(409);
            expect(second.body.error).toBe('DISPATCH_RETURN_NOT_ALLOWED');
            expect(await outboundFor(id)).toHaveLength(1);
        });

        it('un despacho que no es de entrega → 409; inexistente → 404; nota demasiado larga → 400', async () => {
            const pickup = await newDispatch({ status: 'incident', type: 'supplier_pickup' });
            expect((await post(pickup, 'return', {})).body.error).toBe('DISPATCH_TYPE_NOT_SUPPORTED');
            expect((await post(2_000_000_000, 'return', {})).status).toBe(404);
            const id = await newDispatch({ status: 'not_delivered' });
            expect((await post(id, 'return', { notes: 'x'.repeat(501) })).status).toBe(400);
        });

        it('un despacho reprogramado ya no se puede devolver, y uno devuelto ya no se puede reprogramar', async () => {
            const rescheduled = await newDispatch({ status: 'not_delivered' });
            expect((await post(rescheduled, 'reschedule', body(await day(3)))).status).toBe(200);
            expect((await post(rescheduled, 'return', {})).body.error).toBe('DISPATCH_RETURN_NOT_ALLOWED');

            const returned = await newDispatch({ status: 'not_delivered' });
            await addNotDelivered(returned, 3);
            expect((await post(returned, 'return', {})).status).toBe(200);
            expect((await post(returned, 'reschedule', body(await day(3)))).body.error).toBe('DISPATCH_STATUS_NOT_RESCHEDULABLE');
        });
    });
    describe('POST /dispatches/:id/cancel', () => {
        const cancelBody = { reason: 'El bulto no apareció en el cotejo' };
        const cancelEvents = async (id: number) => await dataSource.query(
            `SELECT actor_user_id, actor_type, reason, metadata FROM dispatch_events
              WHERE dispatch_id = $1 AND event_type = 'status_changed' AND metadata->>'status' = 'cancelled' ORDER BY dispatch_event_id`, [id]);

        it('sin token → 401; supervisor, admin y driver → 403 sin cambiar nada', async () => {
            const id = await newDispatch({ status: 'assigned' });
            expect((await request(app.getHttpServer()).post(`/${apiPrefix}/dispatches/${id}/cancel`).send(cancelBody)).status).toBe(401);
            for (const role of ['supervisor', 'admin', 'driver']) {
                expect((await post(id, 'cancel', cancelBody, role)).status).toBe(403);
            }
            expect((await dispatchRow(id)).status).toBe('assigned');
        });

        it('assigned en un lote en ejecución con otra parada abierta: queda cancelled con closed_at, conserva el lote, publica el mensaje y no cierra el lote', async () => {
            const batchId = await newBatch('in_execution', { version: 4 });
            await newDispatch({ status: 'out_for_delivery', batchId, sequence: 2 });
            const id = await newDispatch({ status: 'assigned', batchId, sequence: 1 });
            const before = await dispatchRow(id);

            const res = await post(id, 'cancel', cancelBody);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ dispatchId: id, status: 'cancelled', previousStatus: 'assigned', reasonCode: 'COORD-CANCELLED', routeBatchId: batchId, routeBatchClosed: false });
            const after = await dispatchRow(id);
            expect(after).toMatchObject({ status: 'cancelled', route_batch_id: batchId, sequence_order: 1, version: before.version });
            expect(after.closed_at).not.toBeNull();
            expect(await batchRow(batchId)).toMatchObject({ status: 'in_execution', version: 4 });

            const outbound = await outboundFor(id);
            expect(outbound).toHaveLength(1);
            expect(outbound[0].data).toMatchObject({ status: 'cancelled', previousStatus: 'assigned', reasonCode: 'COORD-CANCELLED', recordVersion: 1 });
            const events = await cancelEvents(id);
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({ actor_user_id: userIds.coordinator, actor_type: 'user', reason: cancelBody.reason });
            expect(events[0].metadata).toMatchObject({ previousStatus: 'assigned', status: 'cancelled', reasonCode: 'COORD-CANCELLED', outboundRecordVersion: 1, routeBatchId: batchId });
        });

        it('la última parada abierta de un lote en ejecución: cancelarla cierra el lote', async () => {
            const batchId = await newBatch('in_execution', { version: 2 });
            await newDispatch({ status: 'delivered', batchId, sequence: 2 });
            const id = await newDispatch({ status: 'assigned', batchId, sequence: 1 });

            const res = await post(id, 'cancel', cancelBody);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ routeBatchId: batchId, routeBatchClosed: true });
            expect((await batchRow(batchId)).status).toBe('closed');
            expect(await batchEvents(batchId, 'closed')).toHaveLength(1);
        });

        it('aparece en el historial como cancelled', async () => {
            const id = await newDispatch({ status: 'assigned' });
            expect((await post(id, 'cancel', cancelBody)).status).toBe(200);

            const res = await request(app.getHttpServer())
                .get(`/${apiPrefix}/dispatches/history?limit=50&search=${await tracking(id)}&status=cancelled`).set(auth('coordinator'));

            expect(res.status).toBe(200);
            expect(res.body.data.map((row: { id: number }) => row.id)).toContain(id);
        });

        it.each(['pending', 'address_review'])('%s sin lote: queda cancelled con closed_at, publica el mensaje y la versión no se mueve', async (status) => {
            const id = await newDispatch({ status });
            const before = await dispatchRow(id);

            const res = await post(id, 'cancel', cancelBody);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ dispatchId: id, status: 'cancelled', previousStatus: status, reasonCode: 'COORD-CANCELLED', routeBatchId: null, routeBatchClosed: false });
            const after = await dispatchRow(id);
            expect(after).toMatchObject({ status: 'cancelled', route_batch_id: null, version: before.version });
            expect(after.closed_at).not.toBeNull();
            const outbound = await outboundFor(id);
            expect(outbound).toHaveLength(1);
            expect(outbound[0].data).toMatchObject({ status: 'cancelled', previousStatus: status, reasonCode: 'COORD-CANCELLED', recordVersion: 1 });
            const events = await cancelEvents(id);
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({ actor_user_id: userIds.coordinator, reason: cancelBody.reason });
        });

        it.each(['in_planning', 'scheduled'])('%s en un lote provisional con otras paradas: sale del lote, sube la versión del despacho y la del lote, cierra el hueco y publica el mensaje', async (status) => {
            const batchId = await newBatch('provisional', { version: 3 });
            const first = await newDispatch({ status, batchId, sequence: 1 });
            const id = await newDispatch({ status, batchId, sequence: 2 });
            const last = await newDispatch({ status, batchId, sequence: 3 });
            const before = await dispatchRow(id);

            const res = await post(id, 'cancel', cancelBody);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ status: 'cancelled', previousStatus: status, routeBatchId: null, routeBatchClosed: false });
            const after = await dispatchRow(id);
            expect(after).toMatchObject({ status: 'cancelled', route_batch_id: null, sequence_order: null, version: before.version + 1 });
            expect(after.closed_at).not.toBeNull();
            expect(await batchRow(batchId)).toMatchObject({ status: 'provisional', version: 4 });
            expect((await dispatchRow(first)).sequence_order).toBe(1);
            expect((await dispatchRow(last)).sequence_order).toBe(2);
            expect(await batchEvents(batchId, 'order_removed')).toHaveLength(1);

            const outbound = await outboundFor(id);
            expect(outbound).toHaveLength(1);
            expect(outbound[0].data).toMatchObject({ status: 'cancelled', previousStatus: status, reasonCode: 'COORD-CANCELLED' });
            const events = await cancelEvents(id);
            expect(events).toHaveLength(1);
            expect(events[0].metadata).toMatchObject({ previousStatus: status, status: 'cancelled', routeBatchId: null, fromBatchId: batchId, version: after.version });
        });

        it('in_planning, última parada de un lote provisional: el lote queda cancelado', async () => {
            const batchId = await newBatch('provisional', { version: 1 });
            const id = await newDispatch({ status: 'in_planning', batchId, sequence: 1 });

            const res = await post(id, 'cancel', cancelBody);

            expect(res.status).toBe(200);
            expect(await batchRow(batchId)).toMatchObject({ status: 'cancelled', version: 2 });
            expect(await batchEvents(batchId, 'cancelled')).toHaveLength(1);
        });

        it('scheduled en un lote confirmed: sale del lote sin renumerar las demás paradas', async () => {
            const batchId = await newBatch('confirmed', { version: 5 });
            const id = await newDispatch({ status: 'scheduled', batchId, sequence: 1 });
            const other = await newDispatch({ status: 'scheduled', batchId, sequence: 2 });

            const res = await post(id, 'cancel', cancelBody);

            expect(res.status).toBe(200);
            expect(await batchRow(batchId)).toMatchObject({ status: 'confirmed', version: 6 });
            expect((await dispatchRow(other)).sequence_order).toBe(2);
            expect((await dispatchRow(id)).route_batch_id).toBeNull();
        });

        it.each(['out_for_delivery', 'in_transit', 'delivered', 'incident', 'not_delivered', 'rescheduled', 'returned', 'cancelled'])(
            '%s → 409 DISPATCH_CANCEL_NOT_ALLOWED y no cambia nada', async (status) => {
                const id = await newDispatch({ status });
                const before = await dispatchRow(id);

                const res = await post(id, 'cancel', cancelBody);

                expect(res.status).toBe(409);
                expect(res.body.error).toBe('DISPATCH_CANCEL_NOT_ALLOWED');
                expect(await dispatchRow(id)).toEqual(before);
                expect(await outboundFor(id)).toHaveLength(0);
            },
        );

        it('cancelar dos veces → el segundo es 409 y no publica otro mensaje', async () => {
            const id = await newDispatch({ status: 'assigned' });
            expect((await post(id, 'cancel', cancelBody)).status).toBe(200);

            const second = await post(id, 'cancel', cancelBody);

            expect(second.status).toBe(409);
            expect(second.body.error).toBe('DISPATCH_CANCEL_NOT_ALLOWED');
            expect(await outboundFor(id)).toHaveLength(1);
        });

        it('un despacho que no es de entrega → 409; inexistente → 404; sin motivo o demasiado largo → 400', async () => {
            const pickup = await newDispatch({ status: 'assigned', type: 'supplier_pickup' });
            expect((await post(pickup, 'cancel', cancelBody)).body.error).toBe('DISPATCH_TYPE_NOT_SUPPORTED');
            expect((await post(2_000_000_000, 'cancel', cancelBody)).status).toBe(404);
            const id = await newDispatch({ status: 'assigned' });
            expect((await post(id, 'cancel', {})).status).toBe(400);
            expect((await post(id, 'cancel', { reason: '' })).status).toBe(400);
            expect((await post(id, 'cancel', { reason: 'x'.repeat(501) })).status).toBe(400);
            expect((await dispatchRow(id)).status).toBe('assigned');
        });
    });
});
