// ST-30.3 / ST-30.4 — Real HTTP/PostgreSQL acceptance checks for driver dispatch status transitions and batch closure.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

type RawSocket = WebSocket;

function connectSocket(url: string, token: string): Promise<RawSocket> {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        let namespaceRequested = false;
        const timeout = setTimeout(() => { socket.close(); reject(new Error('Socket.IO authentication timed out.')); }, 5_000);
        socket.addEventListener('message', (message) => {
            const packet = String(message.data);
            if (packet.startsWith('0') && !namespaceRequested) {
                namespaceRequested = true;
                socket.send(`40/app,${JSON.stringify({ token })}`);
            } else if (packet.startsWith('40/app,')) {
                clearTimeout(timeout);
                resolve(socket);
            } else if (packet.startsWith('44/app,')) {
                clearTimeout(timeout);
                reject(new Error(`Socket.IO rejected the valid JWT: ${packet}`));
            }
        });
        socket.addEventListener('error', () => {
            clearTimeout(timeout);
            reject(new Error('Socket.IO connection failed.'));
        });
    });
}

function socketConnectionRejected(url: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        let namespaceRequested = false;
        let namespaceAccepted = false;
        const timeout = setTimeout(() => { socket.close(); resolve(!namespaceAccepted); }, 5_000);
        socket.addEventListener('message', (message) => {
            const packet = String(message.data);
            if (packet.startsWith('0') && !namespaceRequested) {
                namespaceRequested = true;
                socket.send('40/app,{}');
            } else if (packet.startsWith('40/app,')) {
                namespaceAccepted = true;
            } else if (packet.startsWith('41/app,') || packet.startsWith('44/app,')) {
                clearTimeout(timeout);
                socket.close();
                resolve(true);
            }
        });
        socket.addEventListener('close', () => {
            clearTimeout(timeout);
            resolve(true);
        });
        socket.addEventListener('error', () => {
            clearTimeout(timeout);
            reject(new Error('Socket.IO connection failed before the no-token handshake was rejected.'));
        });
    });
}

function waitForSocketEvent(socket: RawSocket, eventName: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for Socket.IO event ${eventName}.`)), 5_000);
        socket.addEventListener('message', (message) => {
            const packet = String(message.data);
            if (!packet.startsWith('42/app,')) return;
            const [name, payload] = JSON.parse(packet.slice('42/app,'.length)) as [string, Record<string, unknown>];
            if (name !== eventName) return;
            clearTimeout(timeout);
            resolve(payload);
        });
    });
}

describe('PATCH /dispatches/:id/status (e2e, ST-30.3)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    let socketUrl: string;
    const tokens: Record<'driver1' | 'driver2', string> = { driver1: '', driver2: '' };
    const users: Record<'driver1' | 'driver2', number> = { driver1: 0, driver2: 0 };
    const statusIds: Record<string, number> = {};
    const dispatchRefs: string[] = [];
    const batchIds: number[] = [];
    const run = Date.now().toString(36).toUpperCase();
    const prefix = `ST303-${run}`;
    let dispatchSequence = 0;
    let batchSequence = 0;
    let deliveryTypeId: number;

    const auth = (driver: 'driver1' | 'driver2') => ({ Authorization: `Bearer ${tokens[driver]}` });
    const patch = (id: number, body: object, driver: 'driver1' | 'driver2' = 'driver1') =>
        request(app.getHttpServer()).patch(`/${apiPrefix}/dispatches/${id}/status`).set(auth(driver)).send(body);
    const syncEvents = (events: object[], driver: 'driver1' | 'driver2' = 'driver1') =>
        request(app.getHttpServer()).post(`/${apiPrefix}/sync/events`).set(auth(driver)).send({ events });
    const body = (status: string, eventId = uuidv7()) => ({
        status, eventId, occurredAt: new Date().toISOString(), lat: -16.5, lng: -68.1, accuracy: 8.4,
    });

    const newBatch = async (driver: 'driver1' | 'driver2') => {
        const [{ route_batch_id: id }] = await dataSource.query(
            `INSERT INTO route_batches (driver_id, shift_date, status)
             VALUES ($1, DATE '2040-01-01' + $2::int, 'in_execution') RETURNING route_batch_id`,
            [users[driver], batchSequence++],
        );
        batchIds.push(id);
        await dataSource.query(
            `INSERT INTO route_batch_events (route_batch_id, event_type, actor_type, metadata)
             VALUES ($1, 'route_started', 'system', $2::jsonb)`,
            [id, JSON.stringify({ startedAt: new Date(Date.now() - 5 * 60_000).toISOString() })],
        );
        return id as number;
    };

    const newDispatch = async (
        batchId: number,
        status = 'out_for_delivery',
        evidencePolicy = 'hand_delivery_standard',
    ) => {
        const sequenceOrder = ++dispatchSequence;
        const sourceOrderRef = `${prefix}-${sequenceOrder}`;
        dispatchRefs.push(sourceOrderRef);
        const [{ dispatch_id: id }] = await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order,
                                    source_order_ref, tracking_code, delivery_address, evidence_policy)
             VALUES ($1, $2, $3, $4, $5, $6, 'Dirección E2E ST-30.3', $7) RETURNING dispatch_id`,
            [deliveryTypeId, statusIds[status], batchId, sequenceOrder, sourceOrderRef, `DSP-2026-${String(sequenceOrder).padStart(5, '0')}`, evidencePolicy],
        );
        return id as number;
    };

    const addEvidence = async (dispatchId: number, type: 'signature' | 'photo' | 'otp') => {
        await dataSource.query(
            `INSERT INTO delivery_evidences (delivery_evidence_id, dispatch_id, type, file_url, otp_code)
             VALUES ($1, $2, $3, $4, $5)`,
            [uuidv7(), dispatchId, type, type === 'otp' ? null : 'https://example.test/e2e-evidence', null],
        );
    };

    const dispatchRow = async (id: number) => (await dataSource.query(
        `SELECT ds.name AS status, d.version, d.last_latitude, d.last_longitude, d.last_location_at
           FROM dispatches d JOIN dispatch_statuses ds USING (dispatch_status_id)
          WHERE d.dispatch_id = $1`, [id]))[0];

    const batchRow = async (id: number) => (await dataSource.query(
        `SELECT status, closed_at FROM route_batches WHERE route_batch_id = $1`, [id]))[0];

    const closedEventsFor = async (id: number) => dataSource.query(
        `SELECT event_type, actor_user_id, actor_type, reason, metadata
           FROM route_batch_events WHERE route_batch_id = $1 AND event_type = 'closed'
          ORDER BY route_batch_event_id`, [id]);

    const eventsFor = async (id: number) => dataSource.query(
        `SELECT event_type, actor_user_id, actor_type, client_event_id, metadata
           FROM dispatch_events WHERE dispatch_id = $1 AND event_type = 'status_changed'
          ORDER BY dispatch_event_id`, [id]);

    const outboundFor = async (id: number) => dataSource.query(
        `SELECT om.status, om.type, om.payload->'data' AS data
           FROM outbound_messages om
           JOIN dispatches d ON d.source_order_ref = om.payload->'data'->>'salesOrderId'
          WHERE d.dispatch_id = $1 AND om.type = 'dispatch.transfer.status_changed'`, [id]);

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
        await app.listen(0);
        const address = app.getHttpServer().address();
        if (!address || typeof address === 'string') throw new Error('The e2e HTTP server did not expose its ephemeral port.');
        socketUrl = `ws://127.0.0.1:${address.port}/socket.io/?EIO=4&transport=websocket`;
        dataSource = moduleRef.get(DataSource);

        const passwordHash = await hashPassword('E2eTest1234');
        for (const driver of ['driver1', 'driver2'] as const) {
            const [{ role_id: roleId }] = await dataSource.query(`SELECT role_id FROM roles WHERE name = 'driver'`);
            const [{ user_id: userId }] = await dataSource.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change)
                 VALUES ($1, $2, $3, $4, false) RETURNING user_id`,
                [roleId, `ST-30.3 ${driver} ${run}`, `e2e_st303_${driver}_${run}`, passwordHash],
            );
            users[driver] = userId;
            const login = await request(app.getHttpServer()).post(`/${apiPrefix}/auth/login`).send({
                username: `e2e_st303_${driver}_${run}`, password: 'E2eTest1234',
            });
            expect(login.status, `login ${driver}`).toBe(200);
            tokens[driver] = login.body.accessToken as string;
        }

        for (const row of await dataSource.query(`SELECT dispatch_status_id, name FROM dispatch_statuses`)) statusIds[row.name] = row.dispatch_status_id;
        [{ dispatch_type_id: deliveryTypeId }] = await dataSource.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);
    });

    it('retransmite un cambio de estado al cliente Socket.IO autenticado y rechaza al cliente sin JWT', async () => {
        expect(await socketConnectionRejected(socketUrl)).toBe(true);
        const client = await connectSocket(socketUrl, tokens.driver1);
        try {
            const event = waitForSocketEvent(client, 'dispatch.status_changed');
            const id = await newDispatch(await newBatch('driver1'));
            const response = await patch(id, body('in_transit'));

            expect(response.status).toBe(200);
            expect(await event).toMatchObject({
                dispatchId: id,
                status: 'in_transit',
                previousStatus: 'out_for_delivery',
            });
        } finally {
            client.close();
        }
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) {
            await withEventPurge(dataSource, {
                dispatchRefs: dispatchRefs.map((ref) => `${ref}%`),
                routeBatchIds: batchIds,
                userNames: [`e2e_st303_%_${run}`],
            }, async (manager) => {
                await manager.query(`DELETE FROM outbound_messages WHERE payload->'data'->>'salesOrderId' LIKE $1`, [`${prefix}%`]);
                await manager.query(`DELETE FROM dispatch_incidents WHERE dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE source_order_ref LIKE $1)`, [`${prefix}%`]);
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${prefix}%`]);
                if (batchIds.length) await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
                await manager.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_st303_%_${run}`]);
            });
        }
        await app?.close();
    });

    it('permite out_for_delivery → in_transit, audita actor/GPS y no cambia version ni GPS del despacho', async () => {
        const batch = await newBatch('driver1');
        const id = await newDispatch(batch);
        const before = await dispatchRow(id);
        const event = body('in_transit');

        const response = await patch(id, event);

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ dispatchId: id, status: 'in_transit', previousStatus: 'out_for_delivery', version: before.version });
        expect(await dispatchRow(id)).toMatchObject({ status: 'in_transit', version: before.version, last_latitude: before.last_latitude, last_longitude: before.last_longitude, last_location_at: before.last_location_at });
        expect(await eventsFor(id)).toMatchObject([{
            actor_user_id: users.driver1, actor_type: 'user', client_event_id: event.eventId,
            metadata: { previousStatus: 'out_for_delivery', status: 'in_transit', version: before.version, occurredAt: event.occurredAt, lat: event.lat, lng: event.lng, accuracy: event.accuracy },
        }]);
    });

    it('rechaza una transición ilegal con 409 y conserva el estado', async () => {
        const id = await newDispatch(await newBatch('driver1'));
        const response = await patch(id, body('delivered'));
        expect(response.status).toBe(409);
        expect(response.body.error).toBe('DISPATCH_STATUS_TRANSITION_NOT_ALLOWED');
        expect(await dispatchRow(id)).toMatchObject({ status: 'out_for_delivery' });
        expect(await eventsFor(id)).toHaveLength(0);
    });

    it('rechaza delivered con 422 si falta la evidencia de la política', async () => {
        const id = await newDispatch(await newBatch('driver1'), 'in_transit', 'contactless_delivery');
        const response = await patch(id, body('delivered'));
        expect(response.status).toBe(422);
        expect(response.body.error).toBe('DISPATCH_EVIDENCE_REQUIRED');
        expect(await dispatchRow(id)).toMatchObject({ status: 'in_transit' });
        expect(await eventsFor(id)).toHaveLength(0);
    });

    it.each([
        ['hand_delivery_standard', 'signature'],
        ['contactless_delivery', 'photo'],
        ['high_value_control', 'otp'],
    ] as const)('requiere la evidencia %s → %s para confirmar entrega', async (policy, evidenceType) => {
        const id = await newDispatch(await newBatch('driver1'), 'in_transit', policy);
        await addEvidence(id, evidenceType);
        const response = await patch(id, body('delivered'));
        expect(response.status).toBe(200);
        expect(response.body.status).toBe('delivered');
    });

    it('encola delivered una sola vez con payload seguro y recordVersion auditable', async () => {
        const id = await newDispatch(await newBatch('driver1'), 'in_transit');
        await addEvidence(id, 'signature');
        const event = body('delivered');

        expect((await patch(id, event)).status).toBe(200);
        expect((await patch(id, event)).status).toBe(200);

        const messages = await outboundFor(id);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ status: 'pending', type: 'dispatch.transfer.status_changed' });
        expect(messages[0].data).toMatchObject({
            salesOrderId: expect.any(String), trackingCode: expect.any(String), status: 'delivered',
            previousStatus: 'in_transit', recordVersion: 1,
        });
        expect(messages[0].data).not.toHaveProperty('tracking_token');
        expect(messages[0].data).not.toHaveProperty('trackingToken');
        expect(await eventsFor(id)).toMatchObject([{
            metadata: expect.objectContaining({ outboundRecordVersion: 1, status: 'delivered', previousStatus: 'in_transit' }),
        }]);
    });

    it('publica not_delivered desde la sincronización offline y no duplica al reintentar', async () => {
        const id = await newDispatch(await newBatch('driver1'));
        const event = {
            type: 'status_change', clientEventId: uuidv7(), dispatchId: id,
            occurredAt: new Date().toISOString(), dispatchStatusId: statusIds.not_delivered,
            detail: 'Cliente ausente',
        };

        expect((await syncEvents([event])).body.results).toMatchObject([{ clientEventId: event.clientEventId, outcome: 'applied' }]);
        expect((await syncEvents([event])).body.results).toMatchObject([{ clientEventId: event.clientEventId, outcome: 'already_processed' }]);
        expect(await dispatchRow(id)).toMatchObject({ status: 'not_delivered' });
        expect(await outboundFor(id)).toMatchObject([{
            status: 'pending', type: 'dispatch.transfer.status_changed',
            data: expect.objectContaining({ status: 'not_delivered', previousStatus: 'out_for_delivery', recordVersion: 1 }),
        }]);
    });

    it('no permite que el móvil sincronice returned: es una decisión del coordinador', async () => {
        const id = await newDispatch(await newBatch('driver1'));
        const event = {
            type: 'status_change', clientEventId: uuidv7(), dispatchId: id,
            occurredAt: new Date().toISOString(), dispatchStatusId: statusIds.returned,
        };

        const response = await syncEvents([event]);

        expect(response.status).toBe(201);
        expect(response.body.results).toMatchObject([{
            clientEventId: event.clientEventId,
            outcome: 'failed',
            error: 'The driver cannot set dispatch status returned.',
        }]);
        expect(await dispatchRow(id)).toMatchObject({ status: 'out_for_delivery' });
        expect(await eventsFor(id)).toHaveLength(0);
        expect(await outboundFor(id)).toHaveLength(0);
    });

    it('convierte y publica un incidente offline con su reasonCode', async () => {
        const id = await newDispatch(await newBatch('driver1'));
        const [{ incident_reason_id: incidentReasonId, code }] = await dataSource.query(
            `SELECT incident_reason_id, code FROM incident_reasons WHERE active = true AND deleted_at IS NULL ORDER BY incident_reason_id LIMIT 1`,
        );
        const event = {
            type: 'incident', clientEventId: uuidv7(), dispatchId: id,
            occurredAt: new Date().toISOString(), incidentReasonId,
            detail: 'Bulto dañado',
        };

        const response = await syncEvents([event]);

        expect(response.body.results).toMatchObject([{ clientEventId: event.clientEventId, outcome: 'applied' }]);
        expect(await dispatchRow(id)).toMatchObject({ status: 'incident' });
        expect(await outboundFor(id)).toMatchObject([{
            status: 'pending', type: 'dispatch.transfer.status_changed',
            data: expect.objectContaining({
                status: 'incident', previousStatus: 'out_for_delivery', reasonCode: code, recordVersion: 1,
            }),
        }]);
    });

    it('permite reintentar el mismo eventId sin duplicar el evento', async () => {
        const id = await newDispatch(await newBatch('driver1'));
        const event = body('in_transit');
        expect((await patch(id, event)).status).toBe(200);
        expect((await patch(id, event)).status).toBe(200);
        expect(await eventsFor(id)).toHaveLength(1);
    });

    it('reconoce el reintento idempotente después de que se cierra el lote', async () => {
        const batch = await newBatch('driver1');
        const id = await newDispatch(batch);
        const event = body('in_transit');
        expect((await patch(id, event)).status).toBe(200);
        await dataSource.query(`UPDATE route_batches SET status = 'closed' WHERE route_batch_id = $1`, [batch]);

        const retry = await patch(id, event);

        expect(retry.status).toBe(200);
        expect(retry.body).toMatchObject({ dispatchId: id, status: 'in_transit' });
        expect(await eventsFor(id)).toHaveLength(1);
    });

    it('reconoce un eventId ya procesado aunque su occurredAt tenga más de 30 días', async () => {
        const id = await newDispatch(await newBatch('driver1'));
        const event = body('in_transit');
        expect((await patch(id, event)).status).toBe(200);

        const retry = await patch(id, {
            ...event,
            occurredAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
        });

        expect(retry.status).toBe(200);
        expect(retry.body.status).toBe('in_transit');
        expect(await eventsFor(id)).toHaveLength(1);
    });

    it('rechaza un evento de otro repartidor con 403 y no cambia el despacho', async () => {
        const id = await newDispatch(await newBatch('driver1'));
        const response = await patch(id, body('in_transit'), 'driver2');
        expect(response.status).toBe(403);
        expect(response.body.error).toBe('INSUFFICIENT_PERMISSIONS');
        expect(await dispatchRow(id)).toMatchObject({ status: 'out_for_delivery' });
    });

    it('impide iniciar una segunda parada mientras otra sigue in_transit', async () => {
        const batch = await newBatch('driver1');
        const first = await newDispatch(batch);
        const second = await newDispatch(batch);
        expect((await patch(first, body('in_transit'))).status).toBe(200);
        const blocked = await patch(second, body('in_transit'));
        expect(blocked.status).toBe(409);
        expect(blocked.body.error).toBe('ANOTHER_DISPATCH_IN_TRANSIT');
        expect(await dispatchRow(second)).toMatchObject({ status: 'out_for_delivery' });
    });

    it('rechaza un evento anterior al último cambio con 409', async () => {
        const id = await newDispatch(await newBatch('driver1'));
        expect((await patch(id, body('in_transit'))).status).toBe(200);
        const stale = await patch(id, {
            ...body('not_delivered'),
            occurredAt: new Date(Date.now() - 60_000).toISOString(),
        });
        expect(stale.status).toBe(409);
        expect(stale.body.error).toBe('DISPATCH_STATUS_EVENT_OUT_OF_ORDER');
        expect(await dispatchRow(id)).toMatchObject({ status: 'in_transit' });
    });

    it('rechaza una transición desde un despacho terminal con 409', async () => {
        const id = await newDispatch(await newBatch('driver1'), 'delivered');
        const response = await patch(id, body('not_delivered'));
        expect(response.status).toBe(409);
        expect(response.body.error).toBe('DISPATCH_STATUS_TERMINAL');
        expect(await dispatchRow(id)).toMatchObject({ status: 'delivered' });
    });

    it('rechaza un lote que ya no está en ejecución con 409', async () => {
        const batch = await newBatch('driver1');
        const id = await newDispatch(batch);
        await dataSource.query(`UPDATE route_batches SET status = 'closed' WHERE route_batch_id = $1`, [batch]);
        const response = await patch(id, body('in_transit'));
        expect(response.status).toBe(409);
        expect(response.body.error).toBe('ROUTE_BATCH_NOT_IN_EXECUTION');
        expect(await dispatchRow(id)).toMatchObject({ status: 'out_for_delivery' });
    });

    it('no acepta foto ni firma como sustituto del OTP de high_value_control', async () => {
        const id = await newDispatch(await newBatch('driver1'), 'in_transit', 'high_value_control');
        await addEvidence(id, 'signature');
        await addEvidence(id, 'photo');
        const response = await patch(id, body('delivered'));
        expect(response.status).toBe(422);
        expect(response.body.error).toBe('DISPATCH_EVIDENCE_REQUIRED');
        expect(await dispatchRow(id)).toMatchObject({ status: 'in_transit' });
    });

    it('cierra el lote y registra closed como system al entregar la última parada', async () => {
        const batch = await newBatch('driver1');
        const id = await newDispatch(batch, 'in_transit');
        await addEvidence(id, 'signature');

        const response = await patch(id, body('delivered'));

        expect(response.status).toBe(200);
        expect(await batchRow(batch)).toMatchObject({ status: 'closed' });
        expect((await batchRow(batch)).closed_at).toBeTruthy();
        expect(await closedEventsFor(batch)).toMatchObject([{
            event_type: 'closed', actor_user_id: null, actor_type: 'system',
            reason: 'All route dispatches are outside active states.',
            metadata: { dispatchId: id, dispatchStatus: 'delivered' },
        }]);
    });

    it.each(['incident', 'not_delivered'])('no deja abierto el lote por un despacho en %s', async (inactiveStatus) => {
        const batch = await newBatch('driver1');
        const inactive = await newDispatch(batch, inactiveStatus);
        const lastOpen = await newDispatch(batch, 'in_transit');
        await addEvidence(lastOpen, 'signature');

        const response = await patch(lastOpen, body('delivered'));

        expect(response.status).toBe(200);
        expect(await dispatchRow(inactive)).toMatchObject({ status: inactiveStatus });
        expect(await batchRow(batch)).toMatchObject({ status: 'closed' });
        expect(await closedEventsFor(batch)).toHaveLength(1);
    });

    it('mantiene el lote en ejecución mientras queda otra parada en tránsito', async () => {
        const batch = await newBatch('driver1');
        const stillInTransit = await newDispatch(batch, 'in_transit');
        const finalStop = await newDispatch(batch, 'in_transit');

        const response = await patch(finalStop, body('not_delivered'));

        expect(response.status).toBe(200);
        expect(await dispatchRow(stillInTransit)).toMatchObject({ status: 'in_transit' });
        expect(await batchRow(batch)).toMatchObject({ status: 'in_execution', closed_at: null });
        expect(await closedEventsFor(batch)).toHaveLength(0);
    });
});
