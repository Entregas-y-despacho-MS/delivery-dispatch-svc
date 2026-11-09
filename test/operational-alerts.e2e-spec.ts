// ST-66.2 (ES-66, ES-279) — evaluador de alertas operativas. Cubre el Escenario 1 (incidencia
// crítica real → alerta visible por GET/socket) y el control de acceso de GET/PATCH /alerts.
// Las tres evaluaciones periódicas (Escenario 2) y la lógica de deduplicación ya están probadas a
// nivel unitario (operational-alerts.service.spec.ts, operational-alerts-evaluation.service.spec.ts)
// — este e2e no vuelve a correr la tarea programada, solo verifica el camino real HTTP+DB.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';
import { OperationalAlertsEvaluationService } from '../src/modules/operational-alerts/services/operational-alerts-evaluation.service.js';
import { SettingsService } from '../src/modules/settings/services/settings.service.js';

describe('Alertas operativas (e2e, ST-66.2, RF-A19)', () => {
    let app: INestApplication;
    let db: DataSource;
    let prefix: string;
    let evaluation: OperationalAlertsEvaluationService;
    let settings: SettingsService;

    const run = Date.now().toString(36).toUpperCase();
    const tag = `ST662-${run}`;
    const usernames: string[] = [];
    const batchIds: number[] = [];
    const dispatchIds: number[] = [];
    const reasonIds: number[] = [];
    const zoneIds: number[] = [];
    const alertIds: number[] = [];
    const tokens: Record<string, string> = {};
    const users: Record<string, number> = {};
    let deliveryTypeId: number;
    let statusIds: Record<string, number> = {};
    let reasonCode: string;

    const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
    const alertsUrl = (qs = '') => `/${prefix}/alerts${qs ? `?${qs}` : ''}`;
    const listAlerts = (qs = '', who = 'coordinator') => request(app.getHttpServer()).get(alertsUrl(qs)).set(auth(who));
    const acknowledge = (id: number, who = 'coordinator') => request(app.getHttpServer()).patch(`/${prefix}/alerts/${id}/acknowledge`).set(auth(who));
    const reportIncident = (dispatchId: number, who = 'driver') => request(app.getHttpServer())
        .post(`/${prefix}/dispatches/${dispatchId}/incidents`)
        .set(auth(who))
        .send({ incidentId: uuidv7(), reasonCode, observations: 'The customer was not available at the delivery address.', occurredAt: new Date(Date.now() - 60_000).toISOString(), lat: -16.5, lng: -68.1 });

    async function waitForAlert(dispatchId: number, attempts = 20): Promise<{ id: number; status: string } | undefined> {
        for (let i = 0; i < attempts; i++) {
            const [row] = await db.query(`SELECT operational_alert_id AS id, status FROM operational_alerts WHERE dispatch_id = $1 AND kind = 'critical_incident'`, [dispatchId]);
            if (row) {
                alertIds.push(row.id);
                return row;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return undefined;
    }

    async function makeZone(suffix: string): Promise<number> {
        const [{ delivery_zone_id: zoneId }] = await db.query(
            `INSERT INTO delivery_zones (code, name, estimated_time_min) VALUES ($1, $2, 30) RETURNING delivery_zone_id`,
            [`${tag}-${suffix}`.slice(0, 20), `Zona ${suffix} ${tag}`],
        );
        zoneIds.push(zoneId);
        return zoneId;
    }

    /** `in_execution` batch with its own `route_started` event, `startedMinutesAgo` in the past. */
    async function makeStartedBatch(startedMinutesAgo: number, driverId: number): Promise<number> {
        const [{ route_batch_id: batchId }] = await db.query(
            `INSERT INTO route_batches (driver_id, shift_date, status) VALUES ($1, DATE '2040-03-01' + $2::int, 'in_execution') RETURNING route_batch_id`,
            [driverId, batchIds.length],
        );
        batchIds.push(batchId);
        // route_batch_events is append-only (no UPDATE) — created_at is set directly on the one INSERT.
        await db.query(
            `INSERT INTO route_batch_events (route_batch_id, event_type, actor_type, metadata, created_at)
             VALUES ($1, 'route_started', 'system', '{}', NOW() - ($2 || ' minutes')::interval)`,
            [batchId, startedMinutesAgo],
        );
        return batchId;
    }

    async function makeDispatch(driverId: number = users.driver, zoneId: number | null = null): Promise<number> {
        const [{ route_batch_id: batchId }] = await db.query(
            `INSERT INTO route_batches (driver_id, shift_date, status, delivery_zone_id) VALUES ($1, DATE '2040-02-01' + $2::int, 'in_execution', $3) RETURNING route_batch_id`,
            [driverId, batchIds.length, zoneId],
        );
        batchIds.push(batchId);
        const [{ dispatch_id: id }] = await db.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order, source_order_ref, tracking_code, delivery_address)
             VALUES ($1,$2,$3,1,$4,$5,'ST-66.2 incident test address') RETURNING dispatch_id`,
            [deliveryTypeId, statusIds.in_transit, batchId, `${tag}-${batchId}`, `A${run.slice(-5)}${batchId}`.slice(0, 20)],
        );
        dispatchIds.push(id);
        return id;
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
        evaluation = moduleRef.get(OperationalAlertsEvaluationService);
        settings = moduleRef.get(SettingsService);

        const passwordHash = await hashPassword('E2eTest1234');
        // driver2/driver3 are separate accounts so each test has its own subject: the dedup key is
        // (kind, zone, driver), so sharing a driver across tests would let one test's alert mask or
        // collide with another's.
        const accounts: [key: string, role: string][] = [
            ['driver', 'driver'], ['driver2', 'driver'], ['driver3', 'driver'], ['coordinator', 'coordinator'], ['supervisor', 'supervisor'],
        ];
        for (const [key, role] of accounts) {
            const [{ role_id: roleId }] = await db.query('SELECT role_id FROM roles WHERE name = $1', [role]);
            const username = `e2e_st662_${key}_${run}`;
            usernames.push(username);
            const [{ user_id: id }] = await db.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1,$2,$3,$4,false) RETURNING user_id`,
                [roleId, `ST-66.2 ${key}`, username, passwordHash],
            );
            users[key] = id;
            const login = await request(app.getHttpServer()).post(`/${prefix}/auth/login`).send({ username, password: 'E2eTest1234' });
            expect(login.status).toBe(200);
            tokens[key] = login.body.accessToken;
        }

        const rows = await db.query('SELECT name, dispatch_status_id FROM dispatch_statuses');
        statusIds = Object.fromEntries(rows.map((r: { name: string; dispatch_status_id: number }) => [r.name, r.dispatch_status_id]));
        [{ dispatch_type_id: deliveryTypeId }] = await db.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);

        reasonCode = `${tag}-ACCIDENT`;
        const [{ incident_reason_id: reasonId }] = await db.query(
            `INSERT INTO incident_reasons (code, name, requires_evidence, counts_as_attempt, active) VALUES ($1,$2,false,false,true) RETURNING incident_reason_id`,
            [reasonCode, `Accidente ${tag}`],
        );
        reasonIds.push(reasonId);
    }, 30000);

    afterAll(async () => {
        if (db?.isInitialized) {
            await withEventPurge(db, { dispatchRefs: [`${tag}%`], routeBatchIds: batchIds, userNames: [`e2e_st662_%_${run}`] }, async (manager) => {
                await manager.query('DELETE FROM operational_alerts WHERE operational_alert_id = ANY($1::int[])', [alertIds]);
                // gps_stale/driver_incidents alerts key on driver_id (no dispatch_id), not collected in alertIds above.
                await manager.query(
                    `DELETE FROM operational_alerts WHERE driver_id = ANY($1::int[]) AND kind IN ('gps_stale', 'driver_incidents')`,
                    [[users.driver, users.driver2, users.driver3]],
                );
                await manager.query('DELETE FROM dispatch_incidents WHERE dispatch_id = ANY($1::int[])', [dispatchIds]);
                await manager.query('DELETE FROM dispatches WHERE source_order_ref LIKE $1', [`${tag}%`]);
                // route_batch_events has RESTRICT on route_batch_id — must go before the batches themselves.
                await manager.query('DELETE FROM route_batch_events WHERE route_batch_id = ANY($1::int[])', [batchIds]);
                await manager.query('DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])', [batchIds]);
                await manager.query('DELETE FROM delivery_zones WHERE delivery_zone_id = ANY($1::int[])', [zoneIds]);
                await manager.query('DELETE FROM incident_reasons WHERE incident_reason_id = ANY($1::int[])', [reasonIds]);
                await manager.query('DELETE FROM users WHERE username LIKE $1', [`e2e_st662_%_${run}`]);
            });
        }
        await app?.close();
    });

    it('a reported incident raises a critical_incident alert, visible via GET /alerts?status=open', async () => {
        const dispatchId = await makeDispatch();

        const report = await reportIncident(dispatchId);
        expect(report.status).toBe(201);

        const alert = await waitForAlert(dispatchId);
        expect(alert).toBeDefined();
        expect(alert!.status).toBe('open');

        const list = await listAlerts('status=open');
        expect(list.status).toBe(200);
        expect(list.body.data).toContainEqual(expect.objectContaining({ id: alert!.id, kind: 'critical_incident', severity: 'critical', dispatchId, status: 'open' }));
    });

    it('a supervisor can acknowledge an open alert; a second acknowledge answers 409; a bad id answers 404', async () => {
        const dispatchId = await makeDispatch();
        await reportIncident(dispatchId);
        const alert = await waitForAlert(dispatchId);
        expect(alert).toBeDefined();

        const ack = await acknowledge(alert!.id, 'supervisor');
        expect(ack.status).toBe(200);
        expect(ack.body).toMatchObject({ id: alert!.id, status: 'acknowledged', acknowledgedBy: users.supervisor });
        expect(ack.body.acknowledgedAt).not.toBeNull();

        const again = await acknowledge(alert!.id, 'supervisor');
        expect(again.status).toBe(409);
        expect(again.body.error).toBe('OPERATIONAL_ALERT_ALREADY_ACKNOWLEDGED');

        const missing = await acknowledge(999_999_999, 'supervisor');
        expect(missing.status).toBe(404);
        expect(missing.body.error).toBe('OPERATIONAL_ALERT_NOT_FOUND');

        const list = await listAlerts('status=open');
        expect(list.body.data.map((row: { id: number }) => row.id)).not.toContain(alert!.id);
    });

    it('a driver cannot list or acknowledge alerts (403)', async () => {
        const list = await listAlerts('status=open', 'driver');
        expect(list.status).toBe(403);

        const ack = await acknowledge(1, 'driver');
        expect(ack.status).toBe(403);
    });

    it('rejects an unknown status filter with 400', async () => {
        const response = await listAlerts('status=not_a_status');
        expect(response.status).toBe(400);
    });

    it('evaluateGpsStale raises for a batch past the threshold with no position, not for one just started', async () => {
        // Two different drivers: the dedup key is (kind, zone, driver), so sharing one driver between
        // the stale and the fresh batch would let the fresh batch's non-alert hide behind the other's.
        await makeStartedBatch(10, users.driver); // default threshold is 5 minutes
        await makeStartedBatch(1, users.driver2);

        await evaluation.evaluateGpsStale();

        const [stale] = await db.query(`SELECT 1 FROM operational_alerts WHERE kind = 'gps_stale' AND driver_id = $1 AND status = 'open'`, [users.driver]);
        expect(stale).toBeDefined();
        const [fresh] = await db.query(`SELECT 1 FROM operational_alerts WHERE kind = 'gps_stale' AND driver_id = $1`, [users.driver2]);
        expect(fresh).toBeUndefined();
    });

    it('evaluateDriverIncidents raises once a driver reaches the daily threshold, counting across zones', async () => {
        const threshold = await settings.getNumber('driver_incident_alert_per_day', 3);
        const zoneA = await makeZone('A');
        const zoneB = await makeZone('B');
        const inZoneA = Math.ceil(threshold / 2);
        const inZoneB = threshold - inZoneA;

        for (let i = 0; i < inZoneA; i++) {
            const dispatchId = await makeDispatch(users.driver, zoneA);
            expect((await reportIncident(dispatchId)).status).toBe(201);
            await waitForAlert(dispatchId); // registers the critical_incident alert in alertIds for cleanup
        }
        for (let i = 0; i < inZoneB; i++) {
            const dispatchId = await makeDispatch(users.driver, zoneB);
            expect((await reportIncident(dispatchId)).status).toBe(201);
            await waitForAlert(dispatchId);
        }

        await evaluation.evaluateDriverIncidents();

        const [alert] = await db.query(`SELECT detail FROM operational_alerts WHERE kind = 'driver_incidents' AND driver_id = $1 AND zone_id IS NULL AND status = 'open'`, [users.driver]);
        expect(alert).toBeDefined();
        expect(alert.detail.incidentCount).toBeGreaterThanOrEqual(threshold);
    });

    it('an acknowledged gps_stale alert does not come back while its condition is still true', async () => {
        await makeStartedBatch(10, users.driver3);
        await evaluation.evaluateGpsStale();
        const [raised] = await db.query(`SELECT operational_alert_id AS id FROM operational_alerts WHERE kind = 'gps_stale' AND driver_id = $1 AND status = 'open'`, [users.driver3]);
        expect(raised).toBeDefined();

        const ack = await acknowledge(raised.id, 'coordinator');
        expect(ack.status).toBe(200);

        await evaluation.evaluateGpsStale(); // the batch is still started 10+ minutes ago, still no position

        const open = await db.query(`SELECT operational_alert_id FROM operational_alerts WHERE kind = 'gps_stale' AND driver_id = $1 AND status = 'open'`, [users.driver3]);
        expect(open).toHaveLength(0);
        const acknowledged = await db.query(`SELECT operational_alert_id FROM operational_alerts WHERE kind = 'gps_stale' AND driver_id = $1 AND status = 'acknowledged'`, [users.driver3]);
        expect(acknowledged).toHaveLength(1);
    });
});
