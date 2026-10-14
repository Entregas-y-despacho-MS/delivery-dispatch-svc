// ST-50.2 — Generador de lotes provisionales (POST /planning/generate) de punta a punta.
//
// Levanta el AppModule real contra una base de datos real, con OSRM simulado (FakeOsrm) y la lectura de
// candidatos acotada a los pedidos, vehículos y conductores de esta corrida, para no tocar datos de otros
// suites ni de otras personas. Todo lo que crea lleva un prefijo único y se borra en afterAll; las claves
// `stop_service_minutes` y `planning_margin_pct` se restauran a su valor original.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { SettingsService } from '../src/modules/settings/services/settings.service.js';
import { OsrmPort } from '../src/plugins/osrm/osrm.port.js';
import { OsrmUnavailableException } from '../src/plugins/osrm/exceptions/index.js';
import { PlanCandidatesRepository } from '../src/app/planning/services/plan-candidates.repository.js';
import { FakeOsrm } from '../src/app/planning/domain/plan-fixtures.helper-spec.js';
import { SCHEDULED_TASK_RUN_ACTION } from '../src/app/scheduler/adapters/audit-log-task-run-log.adapter.js';
import { PLAN_ALERT_ACTION } from '../src/app/planning/services/planning-alerts.service.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

describe('Plan generation (e2e, ST-50.2)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const startedAt = new Date();
    const run = Date.now().toString(36).toUpperCase();
    const refPrefix = `E2EPLAN-${run}-`;
    const userPrefix = `e2e_plan_`;

    const fakeOsrm = new FakeOsrm();
    const scope = { dispatchIds: new Set<number>(), vehicleIds: new Set<number>(), driverIds: new Set<number>() };
    const originalSettings: Record<string, string> = {};
    let coordinatorToken = '';
    let zoneId = 0;
    let warehouse = { id: 0, lat: 0, lon: 0 };
    let statusId: Record<string, number> = {};
    let seq = 0;
    let coordinatorId = 0;

    // Candidates, vehicles and drivers are limited to what this suite created.
    class ScopedCandidates extends PlanCandidatesRepository {
        async findCandidates() {
            return (await super.findCandidates()).filter((d) => scope.dispatchIds.has(d.dispatchId));
        }
        async findOpenBatches(today: string) {
            return (await super.findOpenBatches(today)).filter((b) => b.stops.some((s) => scope.dispatchIds.has(s.dispatch.dispatchId)));
        }
        async findVehicles() {
            return (await super.findVehicles()).filter((v) => scope.vehicleIds.has(v.vehicleId));
        }
        async findDriverIds() {
            return (await super.findDriverIds()).filter((id) => scope.driverIds.has(id));
        }
    }

    const api = (path: string) => `/${apiPrefix}${path}`;
    const auth = () => ({ Authorization: `Bearer ${coordinatorToken}` });
    const generate = () => request(app.getHttpServer()).post(api('/planning/generate')).set(auth());
    const putSetting = (key: string, value: string) =>
        request(app.getHttpServer()).put(api(`/settings/${key}`)).set(auth()).send({ value });

    const newDispatch = async (km: number, over: { status?: string; weight?: number; zone?: number } = {}): Promise<number> => {
        const [{ dispatch_id }] = await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, delivery_zone_id, origin_warehouse_id, source_order_ref,
                                     delivery_address, delivery_latitude, delivery_longitude, estimated_weight_kg,
                                     order_confirmed_at, shipment_ready)
             VALUES ((SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'), $1, $2, $3, $4,
                     'Dirección de prueba', $5, $6, $7, NOW(), TRUE)
             RETURNING dispatch_id`,
            [statusId[over.status ?? 'pending'], over.zone ?? zoneId, warehouse.id, `${refPrefix}${++seq}`,
             warehouse.lat - km * 0.01, warehouse.lon, over.weight ?? 10],
        );
        scope.dispatchIds.add(dispatch_id);
        return dispatch_id as number;
    };

    const stateOf = async (id: number) => (await dataSource.query(
        `SELECT s.name AS status, d.route_batch_id, d.sequence_order, d.scheduled_window_start, d.scheduled_window_end, d.version
           FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id) WHERE d.dispatch_id = $1`, [id]))[0];
    const batchRow = async (id: number) => (await dataSource.query(
        `SELECT status, version, vehicle_id, proposed_driver_id, driver_id, reviewer_user_id, shift_date::text AS shift_date
           FROM route_batches WHERE route_batch_id = $1`, [id]))[0];
    const batchStops = async (batchId: number) => await dataSource.query(
        `SELECT dispatch_id, sequence_order FROM dispatches WHERE route_batch_id = $1 ORDER BY sequence_order`, [batchId]);

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(OsrmPort).useValue(fakeOsrm)
            .overrideProvider(PlanCandidatesRepository)
            .useFactory({ factory: (ds: DataSource) => new ScopedCandidates(ds), inject: [DataSource] })
            .compile();
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

        const roles: Record<string, number> = {};
        for (const r of await dataSource.query(`SELECT role_id AS id, name FROM roles`)) roles[r.name] = r.id;
        for (const s of await dataSource.query(`SELECT dispatch_status_id AS id, name FROM dispatch_statuses`)) statusId[s.name] = s.id;

        const passwordHash = await hashPassword('E2eTest1234');
        const makeUser = async (key: string, role: string) => {
            const [{ user_id }] = await dataSource.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change, active)
                 VALUES ($1, $2, $3, $4, false, true) RETURNING user_id`,
                [roles[role], `Plan ${key} ${run}`, `${userPrefix}${key}_${run}`, passwordHash],
            );
            return user_id as number;
        };
        coordinatorId = await makeUser('coordinator', 'coordinator');
        scope.driverIds.add(await makeUser('driverA', 'driver'));
        scope.driverIds.add(await makeUser('driverB', 'driver'));
        const login = await request(app.getHttpServer()).post(api('/auth/login'))
            .send({ username: `${userPrefix}coordinator_${run}`, password: 'E2eTest1234' });
        coordinatorToken = login.body.accessToken as string;

        const [{ delivery_zone_id }] = await dataSource.query(
            `INSERT INTO delivery_zones (code, name, estimated_time_min) VALUES ($1, $2, 30) RETURNING delivery_zone_id`,
            [`PL${run}`.slice(0, 20), `Zona e2e plan ${run}`],
        );
        zoneId = delivery_zone_id;

        const [wh] = await dataSource.query(`SELECT warehouse_id, latitude, longitude FROM warehouses WHERE active = TRUE ORDER BY warehouse_id LIMIT 1`);
        warehouse = { id: wh.warehouse_id, lat: Number(wh.latitude), lon: Number(wh.longitude) };

        const [{ vehicle_status_id }] = await dataSource.query(`SELECT vehicle_status_id FROM vehicle_statuses WHERE name = 'active'`);
        for (const [i, capacity] of [[1, 100], [2, 1000]]) {
            const [{ vehicle_id }] = await dataSource.query(
                `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3)
                 VALUES ($1, 'camioneta', 'E2E plan', $2, $3, 50) RETURNING vehicle_id`,
                [vehicle_status_id, `P${run}${i}`.slice(0, 15), capacity],
            );
            scope.vehicleIds.add(vehicle_id);
        }

        for (const key of ['stop_service_minutes', 'planning_margin_pct']) {
            const [row] = await dataSource.query(`SELECT setting_value AS value FROM settings WHERE setting_key = $1`, [key]);
            originalSettings[key] = row?.value ?? '';
        }
    });

    afterAll(async () => {
        for (const [key, value] of Object.entries(originalSettings)) {
            await dataSource.query(`UPDATE settings SET setting_value = $1 WHERE setting_key = $2`, [value, key]);
        }
        const batchIds: number[] = (await dataSource.query(
            `SELECT DISTINCT route_batch_id AS id FROM dispatches WHERE source_order_ref LIKE $1 AND route_batch_id IS NOT NULL`,
            [`${refPrefix}%`],
        )).map((r: { id: number }) => r.id);
        await withEventPurge(dataSource, { dispatchRefs: [`${refPrefix}%`], routeBatchIds: batchIds, userNames: [`${userPrefix}%_${run}`] });
        await dataSource.query(`DELETE FROM dispatch_reservations WHERE dispatch_id = ANY($1::int[])`, [[...scope.dispatchIds]]);
        await dataSource.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${refPrefix}%`]);
        if (batchIds.length) await dataSource.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
        await dataSource.query(`DELETE FROM vehicles WHERE vehicle_id = ANY($1::int[])`, [[...scope.vehicleIds]]);
        await dataSource.query(`DELETE FROM delivery_zones WHERE delivery_zone_id = $1`, [zoneId]);
        await dataSource.query(
            `DELETE FROM audit_logs WHERE created_at >= $1 AND (action = $2 OR (action = $3 AND detail LIKE '%"trigger":"manual"%'))`,
            [startedAt, PLAN_ALERT_ACTION, SCHEDULED_TASK_RUN_ACTION],
        );
        await dataSource.query(`DELETE FROM users WHERE username LIKE $1`, [`${userPrefix}%_${run}`]);
        await app?.close();
    });

    describe('blocked by missing settings', () => {
        it('answers 422 PLANNING_SETTINGS_MISSING with the missing keys, and plans nothing', async () => {
            await dataSource.query(`UPDATE settings SET setting_value = '' WHERE setting_key IN ('stop_service_minutes', 'planning_margin_pct')`);
            await app.get(SettingsService).refresh();
            const pending = await newDispatch(1);

            const res = await generate();

            expect(res.status).toBe(422);
            expect(res.body.error).toBe('PLANNING_SETTINGS_MISSING');
            expect(res.body.details.missingKeys).toEqual(expect.arrayContaining(['stop_service_minutes', 'planning_margin_pct']));
            expect((await stateOf(pending)).status).toBe('pending');
        });
    });

    describe('with the settings in place', () => {
        let batchId = 0;
        let stopIds: number[] = [];

        it('creates one provisional batch in the smallest vehicle, with sequence, slots and reviewer', async () => {
            expect((await putSetting('stop_service_minutes', '15')).status).toBe(200);
            expect((await putSetting('planning_margin_pct', '20')).status).toBe(200);
            // The orders of the previous test are still pending in this scope: three more at different distances.
            stopIds = [...scope.dispatchIds];
            stopIds.push(await newDispatch(3), await newDispatch(1), await newDispatch(2));
            const before = fakeOsrm.calls.length;

            const res = await generate();

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ task: 'plan-generation', status: 'executed' });
            expect(res.body.summary).toMatchObject({ status: 'executed', updatedBatchIds: [], missingKeys: [] });
            expect(res.body.summary.createdBatchIds).toHaveLength(1);
            expect(fakeOsrm.calls.length).toBe(before + 1);

            batchId = res.body.summary.createdBatchIds[0];
            const batch = await batchRow(batchId);
            expect(batch).toMatchObject({ status: 'provisional', version: 0, driver_id: null });
            expect([...scope.vehicleIds]).toContain(batch.vehicle_id);
            expect([...scope.driverIds]).toContain(batch.proposed_driver_id);

            const smallest = (await dataSource.query(
                `SELECT vehicle_id FROM vehicles WHERE vehicle_id = ANY($1::int[]) ORDER BY capacity_kg LIMIT 1`, [[...scope.vehicleIds]]))[0];
            expect(batch.vehicle_id).toBe(smallest.vehicle_id);

            const stops = await batchStops(batchId);
            expect(stops.map((s: any) => s.sequence_order)).toEqual([1, 2, 3, 4]);
            for (const stop of stops) {
                const state = await stateOf(stop.dispatch_id);
                expect(state.status).toBe('in_planning');
                expect(state.scheduled_window_start).not.toBeNull();
                expect(new Date(state.scheduled_window_end).getTime() - new Date(state.scheduled_window_start).getTime()).toBe(2 * 3600_000);
            }

            const events = await dataSource.query(`SELECT event_type, metadata FROM route_batch_events WHERE route_batch_id = $1 ORDER BY route_batch_event_id`, [batchId]);
            expect(events[0].event_type).toBe('created');
            expect(events[0].metadata).toMatchObject({ zoneCode: `PL${run}`.slice(0, 20), stops: 4, trigger: 'manual' });
            expect(events.map((e: any) => e.event_type)).toContain(batch.reviewer_user_id ? 'reviewer_assigned' : 'reviewer_unassigned');

            const [{ count }] = await dataSource.query(
                `SELECT COUNT(*)::int AS count FROM dispatch_events WHERE dispatch_id = ANY($1::int[]) AND event_type = 'status_changed'`, [stopIds]);
            expect(count).toBe(4);
        });

        it('is idempotent: a second run with nothing new plans nothing', async () => {
            const res = await generate();

            expect(res.status).toBe(200);
            expect(res.body.summary).toMatchObject({ createdBatchIds: [], updatedBatchIds: [], plannedDispatchIds: [] });
        });

        it('inserts a late order into the open batch, renumbers without a clash and keeps the notified window', async () => {
            // The first stop was already told its window: it must not move.
            const [first] = await batchStops(batchId);
            await dataSource.query(`UPDATE dispatches SET promise_notified_at = NOW() WHERE dispatch_id = $1`, [first.dispatch_id]);
            const notifiedBefore = await stateOf(first.dispatch_id);
            const late = await newDispatch(2);
            // An order in address_review and one a coordinator is editing must stay out of the plan.
            const review = await newDispatch(1, { status: 'address_review' });
            const reserved = await newDispatch(1);
            await dataSource.query(
                `INSERT INTO dispatch_reservations (dispatch_id, reserved_by, reserved_at, last_activity_at, expires_at)
                 VALUES ($1, $2, NOW(), NOW(), NOW() + INTERVAL '15 minutes')`, [reserved, coordinatorId]);

            const res = await generate();

            expect(res.status).toBe(200);
            expect(res.body.summary.createdBatchIds).toEqual([]);
            expect(res.body.summary.updatedBatchIds).toEqual([batchId]);
            expect(res.body.summary.plannedDispatchIds).toEqual([late]);

            const stops = await batchStops(batchId);
            expect(stops.map((s: any) => s.sequence_order)).toEqual([1, 2, 3, 4, 5]);
            expect(new Set(stops.map((s: any) => s.sequence_order)).size).toBe(5);
            expect(stops.map((s: any) => s.dispatch_id)).toContain(late);

            const notifiedAfter = await stateOf(first.dispatch_id);
            expect(notifiedAfter.scheduled_window_start).toEqual(notifiedBefore.scheduled_window_start);
            expect(notifiedAfter.scheduled_window_end).toEqual(notifiedBefore.scheduled_window_end);

            expect((await batchRow(batchId)).version).toBe(1);
            const added = await dataSource.query(
                `SELECT dispatch_id, metadata FROM route_batch_events WHERE route_batch_id = $1 AND event_type = 'order_added'`, [batchId]);
            expect(added).toHaveLength(1);
            expect(added[0]).toMatchObject({ dispatch_id: late, metadata: { previousSequence: null } });

            expect((await stateOf(review)).status).toBe('address_review');
            expect((await stateOf(reserved)).status).toBe('pending');
            expect((await stateOf(reserved)).route_batch_id).toBeNull();
        });

        it('answers 503 OSRM_UNAVAILABLE and changes nothing when OSRM is down', async () => {
            const stranded = await newDispatch(1);
            fakeOsrm.failWith = new OsrmUnavailableException(5000);
            const batchesBefore = (await dataSource.query(`SELECT COUNT(*)::int AS count FROM route_batches`))[0].count;

            const res = await generate();
            fakeOsrm.failWith = null;

            expect(res.status).toBe(503);
            expect(res.body.error).toBe('OSRM_UNAVAILABLE');
            expect(res.body.message).toContain('5 s');
            expect((await stateOf(stranded)).status).toBe('pending');
            expect((await dataSource.query(`SELECT COUNT(*)::int AS count FROM route_batches`))[0].count).toBe(batchesBefore);
            const [{ count }] = await dataSource.query(
                `SELECT COUNT(*)::int AS count FROM audit_logs WHERE action = $1 AND created_at >= $2 AND detail LIKE '%osrm_unavailable%'`,
                [PLAN_ALERT_ACTION, startedAt]);
            expect(count).toBeGreaterThan(0);
        });

        it('recovers on the next run once OSRM answers again', async () => {
            const res = await generate();

            expect(res.status).toBe(200);
            expect(res.body.summary.plannedDispatchIds.length).toBeGreaterThan(0);
        });
    });
});
