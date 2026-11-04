import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { SETTINGS_VERSION_HEADER } from '../src/modules/settings/settings.constants.js';
import { SettingsService } from '../src/modules/settings/services/settings.service.js';

describe('POST /dispatches/:id/supplier-pickup and /arrived-at-warehouse (ST-239.2)', () => {
    let app: INestApplication;
    let db: DataSource;
    let prefix: string;
    const run = Date.now().toString(36).toUpperCase();
    const tag = `ST2392-${run}`;
    const batchIds: number[] = [];
    const dispatchIds: number[] = [];
    const reasonIds: number[] = [];
    const evidenceIds: string[] = [];
    const tokens: Record<string, string> = {};
    const users: Record<string, number> = {};
    const statusIds: Record<string, number> = {};
    let supplierPickupTypeId: number;
    let reasonCode: string;
    let settingsService: SettingsService;

    const auth = (who = 'driver') => ({ Authorization: `Bearer ${tokens[who]}` });
    const pickupUrl = (id: number) => `/${prefix}/dispatches/${id}/supplier-pickup`;
    const arrivalUrl = (id: number) => `/${prefix}/dispatches/${id}/arrived-at-warehouse`;
    const postPickup = (id: number, body: object, who = 'driver') => request(app.getHttpServer()).post(pickupUrl(id)).set(auth(who)).send(body);
    const postArrival = (id: number, body: object, who = 'driver') => request(app.getHttpServer()).post(arrivalUrl(id)).set(auth(who)).send(body);

    async function dispatch(initialStatus = 'in_transit'): Promise<number> {
        const [{ route_batch_id: batchId }] = await db.query(
            `INSERT INTO route_batches (driver_id, shift_date, status) VALUES ($1, DATE '2040-02-01' + $2::int, 'in_execution') RETURNING route_batch_id`,
            [users.driver, batchIds.length],
        );
        batchIds.push(batchId);
        const ref = `${tag}-${batchId}`;
        const [{ dispatch_id: id }] = await db.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order,
                                    source_order_ref, tracking_code, delivery_address)
             VALUES ($1,$2,$3,1,$4,$5,'ST-239.2 supplier pickup test address') RETURNING dispatch_id`,
            [supplierPickupTypeId, statusIds[initialStatus], batchId, ref, `DSP-2026-${String((Date.now() + batchId) % 100000).padStart(5, '0')}`],
        );
        dispatchIds.push(id);
        await db.query(
            `INSERT INTO dispatch_pickup_items (dispatch_id, item_code, description, expected_quantity)
             VALUES ($1, 'SKU-1', 'Item one', 2), ($1, 'SKU-2', 'Item two', 3)`,
            [id],
        );
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
    // Only a validation placeholder — passes DTO validation for tests whose failure is expected
    // before the signature is ever checked (ownership, type, status). Tests exercising the real
    // signature requirement pass their own signatureId from insertEvidence(..., 'signature', ...).
    const conformBody = (extra: Record<string, unknown> = {}) => ({
        eventId: uuidv7(),
        items: [{ itemCode: 'SKU-1', receivedQuantity: 2 }, { itemCode: 'SKU-2', receivedQuantity: 3 }],
        receivedBoxes: 5,
        occurredAt: new Date(Date.now() - 60_000).toISOString(),
        signatureId: uuidv7(),
        ...gps,
        ...extra,
    });
    const arrivalBody = (extra: Record<string, unknown> = {}) => ({
        eventId: uuidv7(),
        occurredAt: new Date().toISOString(),
        ...gps,
        ...extra,
    });

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        prefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(prefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        db = moduleRef.get(DataSource);
        settingsService = moduleRef.get(SettingsService);

        const passwordHash = await hashPassword('E2eTest1234');
        for (const who of ['driver', 'foreign']) {
            const [{ role_id: roleId }] = await db.query(`SELECT role_id FROM roles WHERE name='driver'`);
            const username = `e2e_st2392_${who}_${run}`;
            const [{ user_id: id }] = await db.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1,$2,$3,$4,false) RETURNING user_id`,
                [roleId, `ST-239.2 ${who}`, username, passwordHash],
            );
            users[who] = id;
            const login = await request(app.getHttpServer()).post(`/${prefix}/auth/login`).send({ username, password: 'E2eTest1234' });
            expect(login.status).toBe(200);
            tokens[who] = login.body.accessToken;
        }
        for (const row of await db.query('SELECT name, dispatch_status_id FROM dispatch_statuses')) statusIds[row.name] = row.dispatch_status_id;
        [{ dispatch_type_id: supplierPickupTypeId }] = await db.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name='supplier_pickup'`);
        reasonCode = `${tag}-QTYMISMATCH`;
        const [{ incident_reason_id: reasonRowId }] = await db.query(
            `INSERT INTO incident_reasons (code, name, requires_evidence, counts_as_attempt, active) VALUES ($1,$2,true,false,true) RETURNING incident_reason_id`,
            [reasonCode, `Quantity mismatch ${tag}`],
        );
        reasonIds.push(reasonRowId);
    }, 30000);

    afterAll(async () => {
        if (db?.isInitialized) await withEventPurge(db, { dispatchRefs: [`${tag}%`], routeBatchIds: batchIds, userNames: [`e2e_st2392_%_${run}`] }, async (manager) => {
            await manager.query('DELETE FROM delivery_evidences WHERE delivery_evidence_id = ANY($1::uuid[])', [evidenceIds]);
            await manager.query('DELETE FROM dispatch_incidents WHERE dispatch_id = ANY($1::int[])', [dispatchIds]);
            await manager.query('DELETE FROM dispatch_pickup_items WHERE dispatch_id = ANY($1::int[])', [dispatchIds]);
            await manager.query('DELETE FROM outbound_messages WHERE payload->\'data\'->>\'purchaseOrderId\' LIKE $1', [`${tag}%`]);
            await manager.query('DELETE FROM dispatches WHERE source_order_ref LIKE $1', [`${tag}%`]);
            await manager.query('DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])', [batchIds]);
            await manager.query('DELETE FROM incident_reasons WHERE incident_reason_id = ANY($1::int[])', [reasonIds]);
            await manager.query('DELETE FROM users WHERE username LIKE $1', [`e2e_st2392_%_${run}`]);
        });
        await app?.close();
    });

    afterEach(() => vi.restoreAllMocks());

    it('registers a conforming collection, moves to picked_up_in_transit and publishes the transfer status', async () => {
        const id = await dispatch();
        const signatureId = await insertEvidence(id, 'signature', 'https://files.test/signature.png');
        const payload = conformBody({ signatureId });

        const response = await postPickup(id, payload);

        expect(response.status).toBe(200);
        expect(response.headers[SETTINGS_VERSION_HEADER.toLowerCase()]).toBe(String(await settingsService.getVersion()));
        expect(response.body).toMatchObject({ dispatchId: id, status: 'picked_up_in_transit', hasDiscrepancy: false });
        expect(await status(id)).toBe('picked_up_in_transit');

        const items = await db.query('SELECT item_code, received_quantity FROM dispatch_pickup_items WHERE dispatch_id=$1 ORDER BY item_code', [id]);
        expect(items).toEqual([
            { item_code: 'SKU-1', received_quantity: '2.00' },
            { item_code: 'SKU-2', received_quantity: '3.00' },
        ]);

        const [event] = await db.query('SELECT event_type, metadata FROM dispatch_events WHERE dispatch_id=$1 AND client_event_id=$2', [id, payload.eventId]);
        expect(event).toMatchObject({ event_type: 'status_changed', metadata: expect.objectContaining({ status: 'picked_up_in_transit', receivedBoxes: 5 }) });

        const [{ dispatch: dispatchRef }] = await db.query('SELECT source_order_ref AS dispatch FROM dispatches WHERE dispatch_id=$1', [id]);
        const [outboxRow] = await db.query(
            `SELECT type, payload FROM outbound_messages WHERE payload->'data'->>'purchaseOrderId' = $1 ORDER BY created_at DESC LIMIT 1`,
            [dispatchRef],
        );
        expect(outboxRow).toMatchObject({ type: 'dispatch.transfer.status_changed' });
        expect(outboxRow.payload.data).toMatchObject({ status: 'picked_up_in_transit', previousStatus: 'in_transit' });

        const replay = await postPickup(id, payload);
        expect(replay.status).toBe(200);
        expect(replay.body).toEqual(response.body);
        expect((await db.query('SELECT count(*)::int AS count FROM dispatch_incidents WHERE dispatch_id=$1', [id]))[0].count).toBe(0);
    });

    it('rejects a quantity difference without reasonCode/photoId with 422', async () => {
        const id = await dispatch();
        const signatureId = await insertEvidence(id, 'signature', 'https://files.test/signature.png');
        const payload = conformBody({ signatureId, items: [{ itemCode: 'SKU-1', receivedQuantity: 1 }, { itemCode: 'SKU-2', receivedQuantity: 3 }] });

        const response = await postPickup(id, payload);

        expect(response.status).toBe(422);
        expect(response.body.error).toBe('SUPPLIER_PICKUP_EVIDENCE_REQUIRED');
        expect(await status(id)).toBe('in_transit');
    });

    it('rejects a missing or foreign signature with 422', async () => {
        const id = await dispatch();

        const missing = await postPickup(id, conformBody({ signatureId: uuidv7() }));
        expect(missing.status).toBe(422);
        expect(missing.body.error).toBe('SUPPLIER_PICKUP_SIGNATURE_REQUIRED');

        const other = await dispatch();
        const foreignSignatureId = await insertEvidence(other, 'signature', 'https://files.test/signature.png');
        const foreign = await postPickup(id, conformBody({ signatureId: foreignSignatureId }));
        expect(foreign.status).toBe(422);
        expect(foreign.body.error).toBe('SUPPLIER_PICKUP_SIGNATURE_REQUIRED');
    });

    it('registers a valid difference as an incident and publishes dispatch.transfer.incident_reported', async () => {
        const id = await dispatch();
        const signatureId = await insertEvidence(id, 'signature', 'https://files.test/signature.png');
        const evidenceId = await insertEvidence(id, 'photo', 'https://files.test/pickup.jpg');
        const payload = conformBody({
            signatureId,
            items: [{ itemCode: 'SKU-1', receivedQuantity: 1 }, { itemCode: 'SKU-2', receivedQuantity: 3 }],
            reasonCode,
            photoId: evidenceId,
        });

        const response = await postPickup(id, payload);

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ dispatchId: id, status: 'picked_up_in_transit', hasDiscrepancy: true });
        expect(await status(id)).toBe('picked_up_in_transit');

        const [incident] = await db.query('SELECT incident_reason_id FROM dispatch_incidents WHERE dispatch_id=$1', [id]);
        expect(incident).toMatchObject({ incident_reason_id: reasonIds[0] });

        const [{ dispatch: dispatchRef }, { tracking: trackingCode }] = [
            (await db.query('SELECT source_order_ref AS dispatch FROM dispatches WHERE dispatch_id=$1', [id]))[0],
            (await db.query('SELECT tracking_code AS tracking FROM dispatches WHERE dispatch_id=$1', [id]))[0],
        ];
        const [incidentMessage] = await db.query(
            `SELECT type, payload FROM outbound_messages WHERE type='dispatch.transfer.incident_reported' AND payload->'data'->>'purchaseOrderId' = $1`,
            [dispatchRef],
        );
        expect(incidentMessage).toBeDefined();
        expect(incidentMessage.payload.data).toMatchObject({ trackingCode, reasonCode, nextStep: 'continue' });
    });

    it('forbids a driver from registering another driver’s dispatch', async () => {
        const id = await dispatch();

        const response = await postPickup(id, conformBody(), 'foreign');

        expect(response.status).toBe(403);
        expect(response.body.error).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('registers the arrival at the warehouse without changing the status, and is idempotent', async () => {
        const id = await dispatch();
        const signatureId = await insertEvidence(id, 'signature', 'https://files.test/signature.png');
        await postPickup(id, conformBody({ signatureId }));
        const eventId = uuidv7();

        const response = await postArrival(id, arrivalBody({ eventId }));

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ dispatchId: id });
        expect(response.body.arrivedAtWarehouseAt).toBeTruthy();
        expect(await status(id)).toBe('picked_up_in_transit');

        const replay = await postArrival(id, arrivalBody({ eventId }));
        expect(replay.status).toBe(200);
        expect(replay.body).toEqual(response.body);

        const again = await postArrival(id, arrivalBody());
        expect(again.status).toBe(409);
        expect(again.body.error).toBe('WAREHOUSE_ARRIVAL_ALREADY_REGISTERED');
    });

    it('rejects a dispatch that is not a supplier_pickup, a wrong status, and items that do not match', async () => {
        const [{ dispatch_type_id: deliveryTypeId }] = await db.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name='delivery'`);
        const wrongType = await dispatch();
        await db.query('UPDATE dispatches SET dispatch_type_id = $1 WHERE dispatch_id = $2', [deliveryTypeId, wrongType]);
        const wrongTypeResponse = await postPickup(wrongType, conformBody());
        expect(wrongTypeResponse.status).toBe(409);
        expect(wrongTypeResponse.body.error).toBe('DISPATCH_NOT_SUPPLIER_PICKUP');

        const notInTransit = await dispatch('picked_up_in_transit');
        const wrongStatusResponse = await postPickup(notInTransit, conformBody());
        expect(wrongStatusResponse.status).toBe(409);
        expect(wrongStatusResponse.body.error).toBe('DISPATCH_NOT_IN_TRANSIT');

        const id = await dispatch();
        const signatureId = await insertEvidence(id, 'signature', 'https://files.test/signature.png');
        const mismatchResponse = await postPickup(id, conformBody({ signatureId, items: [{ itemCode: 'SKU-1', receivedQuantity: 2 }] }));
        expect(mismatchResponse.status).toBe(409);
        expect(mismatchResponse.body.error).toBe('SUPPLIER_PICKUP_ITEMS_MISMATCH');
    });

    it('rejects a reused eventId against a different dispatch or the other endpoint', async () => {
        const id = await dispatch();
        const other = await dispatch();
        const signatureId = await insertEvidence(id, 'signature', 'https://files.test/signature.png');
        const payload = conformBody({ signatureId });
        await postPickup(id, payload);

        const reusedAcrossDispatches = await postPickup(other, { ...payload, eventId: payload.eventId });
        expect(reusedAcrossDispatches.status).toBe(409);
        expect(reusedAcrossDispatches.body.error).toBe('EVENT_ID_ALREADY_USED');

        const reusedAcrossEndpoints = await postArrival(id, arrivalBody({ eventId: payload.eventId }));
        expect(reusedAcrossEndpoints.status).toBe(409);
        expect(reusedAcrossEndpoints.body.error).toBe('EVENT_ID_ALREADY_USED');
    });
});
