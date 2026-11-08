import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

describe('Customer return pickup: POST /dispatches/:id/return-pickup and /arrived-at-warehouse (ST-80.2)', () => {
    let app: INestApplication;
    let db: DataSource;
    let prefix: string;
    const run = Date.now().toString(36).toUpperCase();
    const tag = `ST802-${run}`;
    const batchIds: number[] = [];
    const dispatchIds: number[] = [];
    const evidenceIds: string[] = [];
    const tokens: Record<string, string> = {};
    const users: Record<string, number> = {};
    const statusIds: Record<string, number> = {};
    let pickupTypeId: number;

    const auth = (who = 'driver') => ({ Authorization: `Bearer ${tokens[who]}` });
    const post = (path: string, body: object, who = 'driver') => request(app.getHttpServer()).post(`/${prefix}${path}`).set(auth(who)).send(body);
    const patchStatus = (id: number, body: object, who = 'driver') => request(app.getHttpServer()).patch(`/${prefix}/dispatches/${id}/status`).set(auth(who)).send(body);

    async function pickup(initialStatus = 'in_transit'): Promise<number> {
        const [{ route_batch_id: batchId }] = await db.query(
            `INSERT INTO route_batches (driver_id, shift_date, status) VALUES ($1, DATE '2040-03-01' + $2::int, 'in_execution') RETURNING route_batch_id`,
            [users.driver, batchIds.length],
        );
        batchIds.push(batchId);
        const [{ dispatch_id: id }] = await db.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order,
                                    source_order_ref, tracking_code, delivery_address)
             VALUES ($1,$2,$3,1,$4,$5,'ST-80.2 return pickup test address') RETURNING dispatch_id`,
            [pickupTypeId, statusIds[initialStatus], batchId, `${tag}-${batchId}`, `DSP-2026-${String((Date.now() + batchId) % 100000).padStart(5, '0')}`],
        );
        dispatchIds.push(id);
        return id;
    }

    async function insertEvidence(dispatchId: number, type: string, fileUrl: string): Promise<string> {
        const evidenceId = uuidv7();
        evidenceIds.push(evidenceId);
        await db.query(`INSERT INTO delivery_evidences (delivery_evidence_id, dispatch_id, type, file_url) VALUES ($1,$2,$3,$4)`, [evidenceId, dispatchId, type, fileUrl]);
        return evidenceId;
    }

    async function status(id: number): Promise<string> {
        const [row] = await db.query(
            `SELECT ds.name FROM dispatches d JOIN dispatch_statuses ds ON ds.dispatch_status_id=d.dispatch_status_id WHERE d.dispatch_id=$1`, [id],
        );
        return row.name;
    }

    const gps = { lat: -16.5001, lng: -68.1193, accuracy: 8.4 };
    const complete = { originalPackaging: true, completeParts: true, noMisuseDamage: true };
    const body = (photoId: string, signatureId: string, extra: Record<string, unknown> = {}) => ({
        eventId: uuidv7(), checklist: complete, photoId, signatureId, occurredAt: new Date(Date.now() - 60_000).toISOString(), ...gps, ...extra,
    });
    const arrivalBody = (extra: Record<string, unknown> = {}) => ({ eventId: uuidv7(), occurredAt: new Date().toISOString(), ...gps, ...extra });
    const statusBody = (target: string) => ({ status: target, eventId: uuidv7(), occurredAt: new Date().toISOString(), ...gps });

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        prefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(prefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        db = moduleRef.get(DataSource);

        const passwordHash = await hashPassword('E2eTest1234');
        for (const who of ['driver', 'foreign']) {
            const [{ role_id: roleId }] = await db.query(`SELECT role_id FROM roles WHERE name='driver'`);
            const username = `e2e_st802_${who}_${run}`;
            const [{ user_id: id }] = await db.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1,$2,$3,$4,false) RETURNING user_id`,
                [roleId, `ST-80.2 ${who}`, username, passwordHash],
            );
            users[who] = id;
            const login = await request(app.getHttpServer()).post(`/${prefix}/auth/login`).send({ username, password: 'E2eTest1234' });
            expect(login.status).toBe(200);
            tokens[who] = login.body.accessToken;
        }
        for (const row of await db.query('SELECT name, dispatch_status_id FROM dispatch_statuses')) statusIds[row.name] = row.dispatch_status_id;
        [{ dispatch_type_id: pickupTypeId }] = await db.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name='warehouse_return_pickup'`);
    }, 30000);

    afterAll(async () => {
        if (db?.isInitialized) await withEventPurge(db, { dispatchRefs: [`${tag}%`], routeBatchIds: batchIds, userNames: [`e2e_st802_%_${run}`] }, async (manager) => {
            await manager.query('DELETE FROM delivery_evidences WHERE delivery_evidence_id = ANY($1::uuid[])', [evidenceIds]);
            await manager.query('DELETE FROM outbound_messages WHERE payload->\'data\'->>\'salesOrderId\' LIKE $1', [`${tag}%`]);
            await manager.query('DELETE FROM dispatches WHERE source_order_ref LIKE $1', [`${tag}%`]);
            await manager.query('DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])', [batchIds]);
            await manager.query('DELETE FROM users WHERE username LIKE $1', [`e2e_st802_%_${run}`]);
        });
        await app?.close();
    });

    it('walks the pickup cycle out_for_delivery -> in_transit like a delivery', async () => {
        const id = await pickup('out_for_delivery');

        const response = await patchStatus(id, statusBody('in_transit'));

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ dispatchId: id, status: 'in_transit', previousStatus: 'out_for_delivery' });
        expect(await status(id)).toBe('in_transit');
    });

    it('rejects an incomplete checklist without observations with 422 and changes nothing', async () => {
        const id = await pickup();
        const photoId = await insertEvidence(id, 'photo', 'https://files.test/p.jpg');
        const signatureId = await insertEvidence(id, 'signature', 'https://files.test/s.png');

        for (const observations of [undefined, '', '   ']) {
            const response = await post(`/dispatches/${id}/return-pickup`, body(photoId, signatureId, { checklist: { ...complete, completeParts: false }, observations }));
            expect(response.status).toBe(422);
            expect(response.body.error).toBe('RETURN_PICKUP_OBSERVATIONS_REQUIRED');
        }
        expect(await status(id)).toBe('in_transit');
        expect((await db.query('SELECT count(*)::int AS count FROM dispatch_events WHERE dispatch_id=$1', [id]))[0].count).toBe(0);
    });

    it('registers a valid pickup, records the checklist in dispatch_events and is idempotent', async () => {
        const id = await pickup();
        const photoId = await insertEvidence(id, 'photo', 'https://files.test/p.jpg');
        const signatureId = await insertEvidence(id, 'signature', 'https://files.test/s.png');
        const payload = body(photoId, signatureId);

        const response = await post(`/dispatches/${id}/return-pickup`, payload);

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ dispatchId: id, status: 'picked_up_in_transit', checklistComplete: true });
        expect(await status(id)).toBe('picked_up_in_transit');
        const [custody] = await db.query('SELECT custody_received_at FROM dispatches WHERE dispatch_id=$1', [id]);
        expect(custody.custody_received_at).not.toBeNull();
        const [event] = await db.query('SELECT event_type, metadata FROM dispatch_events WHERE dispatch_id=$1 AND client_event_id=$2', [id, payload.eventId]);
        expect(event).toMatchObject({
            event_type: 'status_changed',
            metadata: expect.objectContaining({ kind: 'return_pickup_collection', status: 'picked_up_in_transit', checklist: complete, photoId, signatureId }),
        });

        const replay = await post(`/dispatches/${id}/return-pickup`, payload);
        expect(replay.status).toBe(200);
        expect(replay.body).toEqual(response.body);
        expect((await db.query('SELECT count(*)::int AS count FROM dispatch_events WHERE dispatch_id=$1', [id]))[0].count).toBe(1);
    });

    it('accepts an incomplete checklist when observations are given', async () => {
        const id = await pickup();
        const photoId = await insertEvidence(id, 'photo', 'https://files.test/p.jpg');
        const signatureId = await insertEvidence(id, 'signature', 'https://files.test/s.png');

        const response = await post(`/dispatches/${id}/return-pickup`, body(photoId, signatureId, {
            checklist: { ...complete, noMisuseDamage: false }, observations: 'Pantalla rayada',
        }));

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ status: 'picked_up_in_transit', checklistComplete: false });
        const [event] = await db.query('SELECT metadata FROM dispatch_events WHERE dispatch_id=$1', [id]);
        expect(event.metadata).toMatchObject({ observations: 'Pantalla rayada', checklistComplete: false });
    });

    it('requires a photo and a signature already uploaded for this dispatch (422)', async () => {
        const id = await pickup();
        const other = await pickup();
        const photoId = await insertEvidence(id, 'photo', 'https://files.test/p.jpg');
        const signatureId = await insertEvidence(id, 'signature', 'https://files.test/s.png');
        const foreignSignature = await insertEvidence(other, 'signature', 'https://files.test/s.png');

        const noPhoto = await post(`/dispatches/${id}/return-pickup`, body(uuidv7(), signatureId));
        expect(noPhoto.status).toBe(422);
        expect(noPhoto.body.error).toBe('RETURN_PICKUP_PHOTO_REQUIRED');

        const foreign = await post(`/dispatches/${id}/return-pickup`, body(photoId, foreignSignature));
        expect(foreign.status).toBe(422);
        expect(foreign.body.error).toBe('RETURN_PICKUP_SIGNATURE_REQUIRED');
        expect(await status(id)).toBe('in_transit');
    });

    it('blocks delivered on a pickup with 409 and leaves it in_transit', async () => {
        const id = await pickup();

        const response = await patchStatus(id, statusBody('delivered'));

        expect(response.status).toBe(409);
        expect(response.body.error).toBe('DELIVERED_NOT_ALLOWED_FOR_PICKUP');
        expect(await status(id)).toBe('in_transit');
    });

    it('rejects another type, a wrong status, another driver and a reused eventId', async () => {
        const [{ dispatch_type_id: deliveryTypeId }] = await db.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name='delivery'`);
        const wrongType = await pickup();
        await db.query('UPDATE dispatches SET dispatch_type_id = $1 WHERE dispatch_id = $2', [deliveryTypeId, wrongType]);
        const typeResponse = await post(`/dispatches/${wrongType}/return-pickup`, body(uuidv7(), uuidv7()));
        expect(typeResponse.status).toBe(409);
        expect(typeResponse.body.error).toBe('DISPATCH_NOT_RETURN_PICKUP');

        const notInTransit = await pickup('out_for_delivery');
        const statusResponse = await post(`/dispatches/${notInTransit}/return-pickup`, body(uuidv7(), uuidv7()));
        expect(statusResponse.status).toBe(409);
        expect(statusResponse.body.error).toBe('DISPATCH_NOT_IN_TRANSIT');

        const mine = await pickup();
        const forbidden = await post(`/dispatches/${mine}/return-pickup`, body(uuidv7(), uuidv7()), 'foreign');
        expect(forbidden.status).toBe(403);

        const first = await pickup();
        const photoId = await insertEvidence(first, 'photo', 'https://files.test/p.jpg');
        const signatureId = await insertEvidence(first, 'signature', 'https://files.test/s.png');
        const payload = body(photoId, signatureId);
        expect((await post(`/dispatches/${first}/return-pickup`, payload)).status).toBe(200);
        const reused = await post(`/dispatches/${mine}/return-pickup`, payload);
        expect(reused.status).toBe(409);
        expect(reused.body.error).toBe('EVENT_ID_ALREADY_USED');
    });

    it('registers the arrival at the warehouse: status unchanged, transfer status published, idempotent', async () => {
        const id = await pickup();
        const photoId = await insertEvidence(id, 'photo', 'https://files.test/p.jpg');
        const signatureId = await insertEvidence(id, 'signature', 'https://files.test/s.png');
        expect((await post(`/dispatches/${id}/return-pickup`, body(photoId, signatureId))).status).toBe(200);
        const eventId = uuidv7();

        const response = await post(`/dispatches/${id}/arrived-at-warehouse`, arrivalBody({ eventId }));

        expect(response.status).toBe(200);
        expect(response.body.arrivedAtWarehouseAt).toBeTruthy();
        expect(await status(id)).toBe('picked_up_in_transit');
        const [{ ref }] = await db.query('SELECT source_order_ref AS ref FROM dispatches WHERE dispatch_id=$1', [id]);
        const [message] = await db.query(
            `SELECT type, payload FROM outbound_messages WHERE payload->'data'->>'salesOrderId' = $1 ORDER BY created_at DESC LIMIT 1`, [ref],
        );
        expect(message).toMatchObject({ type: 'dispatch.transfer.status_changed' });
        expect(message.payload.data).toMatchObject({ status: 'picked_up_in_transit', previousStatus: 'picked_up_in_transit' });

        const replay = await post(`/dispatches/${id}/arrived-at-warehouse`, arrivalBody({ eventId }));
        expect(replay.status).toBe(200);
        expect(replay.body).toEqual(response.body);
        const again = await post(`/dispatches/${id}/arrived-at-warehouse`, arrivalBody());
        expect(again.status).toBe(409);
        expect(again.body.error).toBe('WAREHOUSE_ARRIVAL_ALREADY_REGISTERED');
    });

    it('refuses the arrival before the pickup was collected', async () => {
        const id = await pickup();

        const response = await post(`/dispatches/${id}/arrived-at-warehouse`, arrivalBody());

        expect(response.status).toBe(409);
        expect(response.body.error).toBe('DISPATCH_NOT_PICKED_UP');
    });
});
