import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';
import { DispatchEventsService } from '../src/modules/dispatch/dispatch-events/services/dispatch-events.service.js';
import { SETTINGS_VERSION_HEADER } from '../src/modules/settings/settings.constants.js';
import { SettingsService } from '../src/modules/settings/services/settings.service.js';

describe('POST /dispatches/:id/incidents (ST-32.2)', () => {
    let app: INestApplication;
    let db: DataSource;
    let prefix: string;
    const run = Date.now().toString(36).toUpperCase();
    const tag = `ST322-${run}`;
    const usernames: string[] = [];
    const batchIds: number[] = [];
    const dispatchIds: number[] = [];
    const reasonIds: number[] = [];
    const tokens: Record<string, string> = {};
    const users: Record<string, number> = {};
    const announcements: Record<string, unknown>[] = [];
    const statusIds: Record<string, number> = {};
    let deliveryTypeId: number;
    let dispatchEvents: DispatchEventsService;
    let settingsService: SettingsService;

    const auth = (who = 'driver') => ({ Authorization: `Bearer ${tokens[who]}` });
    const url = (dispatchId: number) => `/${prefix}/dispatches/${dispatchId}/incidents`;
    const requestIncident = (dispatchId: number, body: object, who = 'driver') => request(app.getHttpServer()).post(url(dispatchId)).set(auth(who)).send(body);
    const body = (reasonCode: string, extra: Record<string, unknown> = {}) => ({
        incidentId: uuidv7(), reasonCode, observations: 'The customer was not available at the delivery address.',
        occurredAt: new Date(Date.now() - 60_000).toISOString(), lat: -16.5, lng: -68.1, ...extra,
    });

    async function reason(code: string, name: string, requiresEvidence: boolean, active = true): Promise<void> {
        const [{ incident_reason_id: id }] = await db.query(
            `INSERT INTO incident_reasons (code, name, requires_evidence, counts_as_attempt, active)
             VALUES ($1, $2, $3, false, $4) RETURNING incident_reason_id`,
            [`${tag}-${code}`, code === 'OTHER' ? 'Otro' : `${name} ${tag}`, requiresEvidence, active],
        );
        reasonIds.push(id);
        reasonCodes[code] = `${tag}-${code}`;
    }
    const reasonCodes: Record<string, string> = {};

    async function dispatch(initialStatus = 'in_transit'): Promise<number> {
        const [{ route_batch_id: batchId }] = await db.query(
            `INSERT INTO route_batches (driver_id, shift_date, status) VALUES ($1, DATE '2040-01-01' + $2::int, 'in_execution') RETURNING route_batch_id`,
            [users.driver, batchIds.length],
        );
        batchIds.push(batchId);
        const [{ dispatch_id: id }] = await db.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order,
                                    source_order_ref, tracking_code, delivery_address)
             VALUES ($1,$2,$3,1,$4,$5,'ST-32.2 incident test address') RETURNING dispatch_id`,
            [deliveryTypeId, statusIds[initialStatus], batchId, `${tag}-${batchId}`, `I${run.slice(-5)}${batchId}`.slice(0, 20)],
        );
        dispatchIds.push(id);
        return id;
    }

    async function status(id: number): Promise<string> {
        const [row] = await db.query(
            `SELECT ds.name FROM dispatches d JOIN dispatch_statuses ds ON ds.dispatch_status_id=d.dispatch_status_id WHERE d.dispatch_id=$1`, [id],
        );
        return row.name;
    }

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        prefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(prefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        db = moduleRef.get(DataSource);
        dispatchEvents = moduleRef.get(DispatchEventsService);
        settingsService = moduleRef.get(SettingsService);
        moduleRef.get(EventEmitter2).on('dispatch.incident_reported', (event: Record<string, unknown>) => announcements.push(event));

        const passwordHash = await hashPassword('E2eTest1234');
        for (const who of ['driver', 'foreign']) {
            const [{ role_id: roleId }] = await db.query(`SELECT role_id FROM roles WHERE name='driver'`);
            const username = `e2e_st322_${who}_${run}`;
            usernames.push(username);
            const [{ user_id: id }] = await db.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1,$2,$3,$4,false) RETURNING user_id`,
                [roleId, `ST-32.2 ${who}`, username, passwordHash],
            );
            users[who] = id;
            const login = await request(app.getHttpServer()).post(`/${prefix}/auth/login`).send({ username, password: 'E2eTest1234' });
            expect(login.status).toBe(200);
            tokens[who] = login.body.accessToken;
        }
        for (const row of await db.query('SELECT name, dispatch_status_id FROM dispatch_statuses')) statusIds[row.name] = row.dispatch_status_id;
        [{ dispatch_type_id: deliveryTypeId }] = await db.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name='delivery'`);
        await reason('ABSENT', 'Customer absent', true);
        await reason('COMPFAIL', 'Company or vehicle failure', false);
        await reason('OTHER', 'Otro', false);
        await reason('INACTIVE', 'Inactive reason', false, false);
    }, 30000);

    afterAll(async () => {
        if (db?.isInitialized) await withEventPurge(db, { dispatchRefs: [`${tag}%`], routeBatchIds: batchIds, userNames: [`e2e_st322_%_${run}`] }, async (manager) => {
            // Before deleting the dispatches: operational_alerts.dispatch_id is ON DELETE SET NULL, and
            // several of this file's real incidents can each raise their own critical_incident alert
            // (different dispatch_id at insert time). Deleting the dispatches would null all of them at
            // once, collapsing several previously-distinct open alerts onto the same (kind, zone=-1,
            // dispatch=-1, driver) subject and violating uq_operational_alerts_open_subject mid-DELETE.
            await manager.query('DELETE FROM operational_alerts WHERE dispatch_id = ANY($1::int[])', [dispatchIds]);
            await manager.query('DELETE FROM delivery_evidences WHERE dispatch_id = ANY($1::int[])', [dispatchIds]);
            await manager.query('DELETE FROM dispatch_incidents WHERE dispatch_id = ANY($1::int[])', [dispatchIds]);
            await manager.query('DELETE FROM dispatches WHERE source_order_ref LIKE $1', [`${tag}%`]);
            await manager.query('DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])', [batchIds]);
            await manager.query('DELETE FROM incident_reasons WHERE incident_reason_id = ANY($1::int[])', [reasonIds]);
            await manager.query('DELETE FROM users WHERE username LIKE $1', [`e2e_st322_%_${run}`]);
        });
        await app?.close();
    });

    afterEach(() => vi.restoreAllMocks());

    it('commits incident, status and timeline metadata atomically and emits high-criticality alert after commit', async () => {
        const id = await dispatch();
        const evidenceId = uuidv7();
        await db.query(`INSERT INTO delivery_evidences (delivery_evidence_id, dispatch_id, type, file_url) VALUES ($1,$2,'photo','https://files.test/incident.jpg')`, [evidenceId, id]);
        const report = body(reasonCodes.ABSENT, { evidenceId });

        const response = await requestIncident(id, report);

        expect(response.status).toBe(201);
        expect(response.headers[SETTINGS_VERSION_HEADER.toLowerCase()]).toBe(String(await settingsService.getVersion()));
        expect(response.body).toMatchObject({ dispatchId: id, incidentId: report.incidentId, reasonCode: reasonCodes.ABSENT, status: 'incident' });
        expect(await status(id)).toBe('incident');
        const [incident] = await db.query('SELECT description FROM dispatch_incidents WHERE dispatch_incident_id=$1', [report.incidentId]);
        expect(incident.description).toBe(report.observations);
        const [event] = await db.query('SELECT metadata, event_type FROM dispatch_events WHERE dispatch_id=$1 AND client_event_id=$2', [id, report.incidentId]);
        expect(event).toMatchObject({ event_type: 'status_changed', metadata: expect.objectContaining({ status: 'incident', reasonCode: reasonCodes.ABSENT, evidenceId, lat: report.lat, lng: report.lng }) });
        expect(announcements).toContainEqual(expect.objectContaining({ dispatchId: id, incidentId: report.incidentId, criticality: 'high' }));

        const replay = await requestIncident(id, report);
        expect(replay.status).toBe(200);
        expect(replay.body).toEqual(response.body);
        expect((await db.query('SELECT count(*)::int AS count FROM dispatch_incidents WHERE dispatch_incident_id=$1', [report.incidentId]))[0].count).toBe(1);
        expect(announcements.filter((item) => item.incidentId === report.incidentId)).toHaveLength(1);
        expect((await requestIncident(id, { ...report, observations: 'Changed incident details.' })).status).toBe(409);
    });

    it('requires evidence for an active reason and leaves status and history unchanged when photo is absent', async () => {
        const id = await dispatch();
        const report = body(reasonCodes.ABSENT);
        const response = await requestIncident(id, report);
        expect(response.status).toBe(422);
        expect(await status(id)).toBe('in_transit');
        expect(await db.query('SELECT 1 FROM dispatch_incidents WHERE dispatch_id=$1', [id])).toHaveLength(0);
        expect(await db.query('SELECT 1 FROM dispatch_events WHERE dispatch_id=$1 AND client_event_id=$2', [id, report.incidentId])).toHaveLength(0);
    });

    it('rolls back incident and status when the history write fails', async () => {
        const id = await dispatch();
        const report = body(reasonCodes.COMPFAIL);
        vi.spyOn(dispatchEvents, 'create').mockRejectedValueOnce(new Error('simulated history write failure'));

        const response = await requestIncident(id, report);

        expect(response.status).toBe(500);
        expect(await status(id)).toBe('in_transit');
        expect(await db.query('SELECT 1 FROM dispatch_incidents WHERE dispatch_incident_id=$1', [report.incidentId])).toHaveLength(0);
        expect(await db.query('SELECT 1 FROM dispatch_events WHERE dispatch_id=$1 AND client_event_id=$2', [id, report.incidentId])).toHaveLength(0);
        expect(announcements.some((item) => item.incidentId === report.incidentId)).toBe(false);
    });

    it('returns 404 for an inactive reason and 400 for short observations on catalog label Otro', async () => {
        const id = await dispatch();
        expect((await requestIncident(id, body(reasonCodes.INACTIVE))).status).toBe(404);
        expect((await requestIncident(id, body(reasonCodes.OTHER, { observations: 'Short' }))).status).toBe(400);
        expect(await status(id)).toBe('in_transit');
    });

    it('accepts company failure without photo and preserves promise-related dispatch fields', async () => {
        const id = await dispatch();
        const [{ scheduled_window_start: beforeStart, scheduled_window_end: beforeEnd, promise_firmed_at: beforeFirmed }] = await db.query(
            'SELECT scheduled_window_start, scheduled_window_end, promise_firmed_at FROM dispatches WHERE dispatch_id=$1', [id],
        );
        const report = body(reasonCodes.COMPFAIL);
        const response = await requestIncident(id, report);
        expect(response.status).toBe(201);
        const [{ scheduled_window_start: afterStart, scheduled_window_end: afterEnd, promise_firmed_at: afterFirmed }] = await db.query(
            'SELECT scheduled_window_start, scheduled_window_end, promise_firmed_at FROM dispatches WHERE dispatch_id=$1', [id],
        );
        expect([afterStart, afterEnd, afterFirmed]).toEqual([beforeStart, beforeEnd, beforeFirmed]);
    });

    it('denies another driver and returns 404 for an unknown dispatch', async () => {
        const id = await dispatch();
        expect((await requestIncident(id, body(reasonCodes.COMPFAIL), 'foreign')).status).toBe(403);
        expect((await requestIncident(2_000_000_000, body(reasonCodes.COMPFAIL))).status).toBe(404);
        expect(await status(id)).toBe('in_transit');
    });

    it('applies the FIFO status then incident requests using their direct routes', async () => {
        const id = await dispatch('out_for_delivery');
        const statusResponse = await request(app.getHttpServer())
            .patch(`/${prefix}/dispatches/${id}/status`)
            .set(auth())
            .send({ status: 'in_transit', eventId: uuidv7(), occurredAt: new Date().toISOString(), lat: -16.5, lng: -68.1, accuracy: 8 });
        expect(statusResponse.status).toBe(200);
        expect(statusResponse.headers[SETTINGS_VERSION_HEADER.toLowerCase()]).toBe(String(await settingsService.getVersion()));
        expect(await status(id)).toBe('in_transit');

        const report = body(reasonCodes.COMPFAIL);
        const response = await requestIncident(id, report);
        expect(response.status).toBe(201);
        expect(response.body.status).toBe('incident');
        expect(await status(id)).toBe('incident');
    });
});
