// ST-302.2 — Universo de planificación por corte y manifiestos de ruta, de punta a punta.
//
// Levanta el AppModule real contra una base de datos real, con OSRM simulado (FakeOsrm). Corre el corte de verdad
// (el snapshot programado con `CutoffSnapshotService`, el manual con POST /planning/cutoff), aprueba la ruta por la API
// y lee la cobertura y la finalización por los tres endpoints. Todo lo que crea lleva un prefijo único y se borra en
// afterAll; los datos de otros suites no entran en las cifras porque cada lectura se filtra por la zona de esta corrida.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { OsrmPort } from '../src/plugins/osrm/osrm.port.js';
import { PlanCandidatesRepository } from '../src/app/planning/services/plan-candidates.repository.js';
import { FakeOsrm } from '../src/app/planning/domain/plan-fixtures.helper-spec.js';
import { localDate, localInstant, nextOperatingDay } from '../src/app/planning/domain/operating-calendar.js';
import { loadPlanningSettings } from '../src/app/planning/domain/planning-settings.js';
import { SettingsService } from '../src/modules/settings/services/settings.service.js';
import { CutoffBatchesRepository } from '../src/app/route-cutoff/services/cutoff-batches.repository.js';
import { CutoffSnapshotService } from '../src/app/planning-snapshots/services/cutoff-snapshot.service.js';
import { RouteManifestService } from '../src/modules/dispatch/route-manifests/services/route-manifest.service.js';
import { SCHEDULED_TASK_RUN_ACTION } from '../src/app/scheduler/adapters/audit-log-task-run-log.adapter.js';
import { PLAN_ALERT_ACTION } from '../src/app/planning/services/planning-alerts.service.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

type Kind = 'firm' | 'elapsed' | 'open' | 'none';

describe('Planning snapshots (e2e, ST-302.2)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const startedAt = new Date();
    const run = Date.now().toString(36).toUpperCase();
    const refPrefix = `E2ESNAP-${run}-`;
    const userPrefix = 'e2e_snap_';
    // Dates with no real batch, so the tests that need an empty day or a day of our own never meet other data.
    const EMPTY_DAY = '2099-01-01';
    const MANUAL_ONLY_DAY = '2098-03-03';
    const scheduledOccurrence = `route-cutoff@E2E-${run}`;

    const fakeOsrm = new FakeOsrm();
    const scope = { dispatchIds: new Set<number>(), vehicleIds: new Set<number>(), zoneIds: [] as number[], batchIds: new Set<number>() };
    const originalSettings: Record<string, string> = {};
    let coordinatorToken = '';
    let supervisorToken = '';
    let coordinatorId = 0;
    let driverId = 0;
    let warehouse = { id: 0, lat: 0, lon: 0 };
    let statusId: Record<string, number> = {};
    let shiftDate = '';
    let windowMinutes = 720;
    let zoneId = 0;
    let seq = 0;

    // The cutoff reorganizes only the batches of this run: another provisional batch would compete for its vehicles.
    class ScopedBatches extends CutoffBatchesRepository {
        async findProvisionalBatches(date: string) {
            const read = await super.findProvisionalBatches(date);
            return {
                batches: read.batches.filter((b) => scope.batchIds.has(b.routeBatchId)),
                skippedBatchIds: read.skippedBatchIds.filter((id) => scope.batchIds.has(id)),
            };
        }
    }
    class ScopedCandidates extends PlanCandidatesRepository {
        async findVehicles() {
            return (await super.findVehicles()).filter((v) => scope.vehicleIds.has(v.vehicleId));
        }
    }

    const api = (path: string) => `/${apiPrefix}${path}`;
    const as = (token: string) => ({ Authorization: `Bearer ${token}` });
    const get = (path: string, token = coordinatorToken) => request(app.getHttpServer()).get(api(path)).set(as(token));
    const post = (path: string, body: object = {}) => request(app.getHttpServer()).post(api(path)).set(as(coordinatorToken)).send(body);
    const putSetting = (key: string, value: string) => request(app.getHttpServer()).put(api(`/settings/${key}`)).set(as(coordinatorToken)).send({ value });

    const makeUser = async (key: string, role: string, roles: Record<string, number>, passwordHash: string): Promise<number> => {
        const [{ user_id }] = await dataSource.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change, active)
             VALUES ($1, $2, $3, $4, false, true) RETURNING user_id`,
            [roles[role], `Snap ${key} ${run}`, `${userPrefix}${key}_${run}`, passwordHash],
        );
        return user_id as number;
    };
    const login = async (key: string): Promise<string> => {
        const response = await request(app.getHttpServer()).post(api('/auth/login')).send({ username: `${userPrefix}${key}_${run}`, password: 'E2eTest1234' });
        return response.body.accessToken as string;
    };

    /** A provisional batch of the route day; the kind of each stop decides the state of its promise. */
    const makeBatch = async (vehicleId: number, kinds: Kind[]) => {
        const [{ route_batch_id }] = await dataSource.query(
            `INSERT INTO route_batches (status, version, shift_date, delivery_zone_id, origin_warehouse_id, vehicle_id, proposed_driver_id, reviewer_user_id)
             VALUES ('provisional', 2, $1::date, $2, $3, $4, $5, $6) RETURNING route_batch_id`,
            [shiftDate, zoneId, warehouse.id, vehicleId, driverId, coordinatorId],
        );
        scope.batchIds.add(route_batch_id);
        const minute = 60_000;
        const dispatchIds: number[] = [];
        for (const [index, kind] of kinds.entries()) {
            const now = Date.now();
            const notifiedAt = kind === 'open' ? new Date(now - 10 * minute)
                : kind === 'elapsed' ? new Date(now - (windowMinutes + 60) * minute)
                : kind === 'firm' ? new Date(now - (windowMinutes + 120) * minute) : null;
            const firmedAt = kind === 'firm' ? new Date(now - 60 * minute) : null;
            const [{ dispatch_id }] = await dataSource.query(
                `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, delivery_zone_id, origin_warehouse_id, source_order_ref,
                                         delivery_address, delivery_latitude, delivery_longitude, estimated_weight_kg,
                                         order_confirmed_at, shipment_ready, route_batch_id, sequence_order,
                                         scheduled_window_start, scheduled_window_end, promise_notified_at, promise_firmed_at, version)
                 VALUES ((SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'), $1, $2, $3, $4,
                         'Dirección de prueba', $5, $6, 10, NOW(), TRUE, $7, $8, $9, $10, $11, $12, 1)
                 RETURNING dispatch_id`,
                [statusId[kind === 'none' ? 'in_planning' : 'scheduled'], zoneId, warehouse.id, `${refPrefix}${++seq}`,
                 warehouse.lat - (index + 1) * 0.01, warehouse.lon, route_batch_id, index + 1,
                 localInstant(shiftDate, '08:00'), localInstant(shiftDate, '18:00'), notifiedAt, firmedAt],
            );
            scope.dispatchIds.add(dispatch_id);
            dispatchIds.push(dispatch_id);
            await dataSource.query(
                `INSERT INTO dispatch_packages (dispatch_id, external_package_id, length_cm, width_cm, height_cm, gross_weight_kg) VALUES ($1, $2, 20, 20, 20, 10)`,
                [dispatch_id, `PKG-${dispatch_id}`],
            );
        }
        return { batchId: route_batch_id as number, dispatchIds };
    };

    const cutoffRowOf = async (dispatchId: number, trigger: 'scheduled' | 'manual') => (await dataSource.query(
        `SELECT c.planning_cutoff_id AS id FROM planning_cutoffs c
           JOIN planning_cutoff_dispatches i ON i.planning_cutoff_id = c.planning_cutoff_id
          WHERE i.dispatch_id = $1 AND c.trigger_type = $2 ORDER BY c.planning_cutoff_id DESC LIMIT 1`,
        [dispatchId, trigger],
    ))[0]?.id as number | undefined;
    const coverage = (query: string) => get(`/planning/cutoffs/coverage?${query}`);

    // The five stops of the plan: three are eligible (a firm promise and two whose window closed), one has its window
    // still open and one was never approved.
    let ids: { firm: number; elapsedA: number; elapsedB: number; open: number; none: number };
    let batchId = 0;

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(OsrmPort).useValue(fakeOsrm)
            .overrideProvider(CutoffBatchesRepository).useFactory({ factory: (ds: DataSource) => new ScopedBatches(ds), inject: [DataSource] })
            .overrideProvider(PlanCandidatesRepository).useFactory({ factory: (ds: DataSource) => new ScopedCandidates(ds), inject: [DataSource] })
            .compile();
        app = moduleRef.createNestApplication();
        apiPrefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(apiPrefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        dataSource = moduleRef.get(DataSource);

        const roles: Record<string, number> = {};
        for (const r of await dataSource.query(`SELECT role_id AS id, name FROM roles`)) roles[r.name] = r.id;
        for (const s of await dataSource.query(`SELECT dispatch_status_id AS id, name FROM dispatch_statuses`)) statusId[s.name] = s.id;
        const passwordHash = await hashPassword('E2eTest1234');
        coordinatorId = await makeUser('coordinator', 'coordinator', roles, passwordHash);
        await makeUser('supervisor', 'supervisor', roles, passwordHash);
        driverId = await makeUser('driver', 'driver', roles, passwordHash);
        coordinatorToken = await login('coordinator');
        supervisorToken = await login('supervisor');

        const [wh] = await dataSource.query(`SELECT warehouse_id, latitude, longitude FROM warehouses WHERE active = TRUE ORDER BY warehouse_id LIMIT 1`);
        warehouse = { id: wh.warehouse_id, lat: Number(wh.latitude), lon: Number(wh.longitude) };
        for (const key of ['stop_service_minutes', 'planning_margin_pct']) {
            const [row] = await dataSource.query(`SELECT setting_value AS value FROM settings WHERE setting_key = $1`, [key]);
            originalSettings[key] = row?.value ?? '';
        }
        expect((await putSetting('stop_service_minutes', '15')).status).toBe(200);
        expect((await putSetting('planning_margin_pct', '20')).status).toBe(200);
        const loaded = await loadPlanningSettings(app.get(SettingsService));
        expect(loaded.ok).toBe(true);
        windowMinutes = loaded.values!.promiseRules.promiseResponseWindowMinutes;
        shiftDate = nextOperatingDay(localDate(new Date()), loaded.values!.calendar);

        const [{ delivery_zone_id }] = await dataSource.query(
            `INSERT INTO delivery_zones (code, name, estimated_time_min) VALUES ($1, $2, 30) RETURNING delivery_zone_id`,
            [`SN${run}`.slice(0, 20), `Zona e2e snapshots ${run}`],
        );
        zoneId = delivery_zone_id;
        scope.zoneIds.push(zoneId);
        const [{ vehicle_status_id }] = await dataSource.query(`SELECT vehicle_status_id FROM vehicle_statuses WHERE name = 'active'`);
        const [{ vehicle_id }] = await dataSource.query(
            `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3) VALUES ($1, 'camioneta', 'E2E snapshots', $2, 1000, 50) RETURNING vehicle_id`,
            [vehicle_status_id, `S${run}`.slice(0, 15)],
        );
        scope.vehicleIds.add(vehicle_id);

        const made = await makeBatch(vehicle_id, ['firm', 'elapsed', 'elapsed', 'open', 'none']);
        batchId = made.batchId;
        const [firm, elapsedA, elapsedB, open, none] = made.dispatchIds;
        ids = { firm, elapsedA, elapsedB, open, none };
    });

    afterAll(async () => {
        for (const [key, value] of Object.entries(originalSettings)) {
            await dataSource.query(`UPDATE settings SET setting_value = $1 WHERE setting_key = $2`, [value, key]);
        }
        const batchIds: number[] = scope.zoneIds.length
            ? (await dataSource.query(`SELECT route_batch_id AS id FROM route_batches WHERE delivery_zone_id = ANY($1::int[])`, [scope.zoneIds])).map((r: { id: number }) => r.id)
            : [];
        await withEventPurge(dataSource, { dispatchRefs: [`${refPrefix}%`], routeBatchIds: batchIds, userNames: [`${userPrefix}%_${run}`] }, async (manager) => {
            // The headers with no dispatch (a day with no batch, a manual run) do not belong to any dispatch, so they go by their own marks.
            await manager.query(`DELETE FROM planning_cutoffs WHERE occurrence LIKE $1 OR shift_date = ANY($2::date[])`, [`${scheduledOccurrence}%`, [EMPTY_DAY, MANUAL_ONLY_DAY]]);
        });
        await dataSource.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${refPrefix}%`]);
        if (batchIds.length) await dataSource.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
        if (scope.vehicleIds.size) await dataSource.query(`DELETE FROM vehicles WHERE vehicle_id = ANY($1::int[])`, [[...scope.vehicleIds]]);
        if (scope.zoneIds.length) await dataSource.query(`DELETE FROM delivery_zones WHERE delivery_zone_id = ANY($1::int[])`, [scope.zoneIds]);
        await dataSource.query(
            `DELETE FROM audit_logs WHERE created_at >= $1 AND (action = $2 OR (action = $3 AND detail LIKE '%"trigger":"manual"%'))`,
            [startedAt, PLAN_ALERT_ACTION, SCHEDULED_TASK_RUN_ACTION],
        );
        await dataSource.query(`DELETE FROM users WHERE username LIKE $1`, [`${userPrefix}%_${run}`]);
        await app?.close();
    });

    describe('the universe of a scheduled cutoff', () => {
        it('saves who was eligible and who was left out, each exclusion with its code and explanation', async () => {
            const now = new Date();
            const result = await app.get(CutoffSnapshotService).capture({ shiftDate, now, windowMinutes, manual: false, occurrence: scheduledOccurrence });

            expect(result.created).toBe(true);
            const items = await dataSource.query(
                `SELECT dispatch_id, universe_status, exclusion_code, exclusion_detail, route_batch_id, route_version, delivery_zone_id, origin_warehouse_id
                   FROM planning_cutoff_dispatches WHERE planning_cutoff_id = $1 ORDER BY dispatch_id`,
                [result.planningCutoffId],
            );
            const mine = items.filter((item: { dispatch_id: number }) => scope.dispatchIds.has(item.dispatch_id));
            expect(mine.map((item: { dispatch_id: number; universe_status: string; exclusion_code: string | null }) => [item.dispatch_id, item.universe_status, item.exclusion_code])).toEqual([
                [ids.firm, 'eligible', null],
                [ids.elapsedA, 'eligible', null],
                [ids.elapsedB, 'eligible', null],
                [ids.open, 'excluded', 'cutoff_window_open'],
                [ids.none, 'excluded', 'cutoff_no_promise'],
            ]);
            for (const item of mine.filter((row: { universe_status: string }) => row.universe_status === 'excluded')) expect(item.exclusion_detail.length).toBeGreaterThan(10);
            // What the dispatch had at the cutoff, not what it has today.
            expect(mine[0]).toMatchObject({ route_batch_id: batchId, route_version: 2, delivery_zone_id: zoneId, origin_warehouse_id: warehouse.id });
            const [header] = await dataSource.query(`SELECT trigger_type, occurrence, operating_timezone, shift_date::text AS shift_date FROM planning_cutoffs WHERE planning_cutoff_id = $1`, [result.planningCutoffId]);
            expect(header).toEqual({ trigger_type: 'scheduled', occurrence: scheduledOccurrence, operating_timezone: 'America/La_Paz', shift_date: shiftDate });
        });

        it('keeps the first snapshot when the same occurrence runs again', async () => {
            const before = await dataSource.query(`SELECT count(*)::int AS n FROM planning_cutoff_dispatches WHERE planning_cutoff_id = (SELECT planning_cutoff_id FROM planning_cutoffs WHERE occurrence = $1)`, [scheduledOccurrence]);
            // A different instant and window: the second run must not rewrite anything.
            const again = await app.get(CutoffSnapshotService).capture({ shiftDate, now: new Date(Date.now() + 3_600_000), windowMinutes: 1, manual: false, occurrence: scheduledOccurrence });

            expect(again.created).toBe(false);
            const after = await dataSource.query(`SELECT count(*)::int AS n FROM planning_cutoff_dispatches WHERE planning_cutoff_id = $1`, [again.planningCutoffId]);
            expect(after[0].n).toBe(before[0].n);
            expect(await dataSource.query(`SELECT 1 FROM planning_cutoffs WHERE occurrence = $1`, [scheduledOccurrence])).toHaveLength(1);
        });

        it('refuses to rewrite or delete a snapshot', async () => {
            const [{ planning_cutoff_id }] = await dataSource.query(`SELECT planning_cutoff_id FROM planning_cutoffs WHERE occurrence = $1`, [scheduledOccurrence]);
            await expect(dataSource.query(`UPDATE planning_cutoffs SET shift_date = shift_date WHERE planning_cutoff_id = $1`, [planning_cutoff_id])).rejects.toThrow(/append-only/);
            await expect(dataSource.query(`DELETE FROM planning_cutoff_dispatches WHERE planning_cutoff_id = $1`, [planning_cutoff_id])).rejects.toThrow(/append-only/);
        });
    });

    describe('the cutoff run by hand', () => {
        it('saves its own snapshot, marked as manual, and the scheduled one stays the official of the day', async () => {
            const response = await post('/planning/cutoff');
            expect(response.status).toBe(200);

            const list = await get(`/planning/cutoffs?date=${shiftDate}`);
            expect(list.status).toBe(200);
            const mineScheduled = list.body.data.find((item: { occurrence: string | null }) => item.occurrence === scheduledOccurrence);
            expect(mineScheduled).toMatchObject({ triggerType: 'scheduled', official: true, operatingTimezone: 'America/La_Paz' });
            const manualId = await cutoffRowOf(ids.firm, 'manual');
            expect(manualId).toBeDefined();
            expect(list.body.data.find((item: { id: number }) => item.id === manualId)).toMatchObject({ triggerType: 'manual', occurrence: null, official: false });
        });

        it('reorganized the batch with the same rule that classified it: the open window waits, the one without promise is released', async () => {
            const row = async (id: number) => (await dataSource.query(
                `SELECT s.name AS status, d.route_batch_id FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id) WHERE d.dispatch_id = $1`, [id]))[0];
            expect((await row(ids.none)).status).toBe('pending');
            expect((await row(ids.open)).route_batch_id).not.toBe(batchId);
            expect((await row(ids.firm)).route_batch_id).toBe(batchId);
        });
    });

    describe('coverage at the cutoff', () => {
        let scheduledId = 0;
        let manualId = 0;
        beforeAll(async () => {
            scheduledId = (await cutoffRowOf(ids.firm, 'scheduled'))!;
            manualId = (await cutoffRowOf(ids.firm, 'manual'))!;
        });

        it('counts confirmed over the eligible ones of the same cutoff, and lists every exclusion with code and explanation', async () => {
            const response = await coverage(`cutoffId=${scheduledId}&zoneId=${zoneId}`);

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ available: true, reason: null, cutoff: { id: scheduledId, official: true, triggerType: 'scheduled' } });
            expect(response.body.coverage).toEqual({ eligible: 3, confirmed: 0, pending: 3, coveragePct: 0, confirmedOutsideUniverse: 0 });
            expect(response.body.excluded.total).toBe(2);
            expect(response.body.excluded.byCode.map((item: { code: string; count: number }) => [item.code, item.count])).toEqual([['cutoff_no_promise', 1], ['cutoff_window_open', 1]]);
            for (const item of response.body.excluded.byCode) expect(item.explanation.length).toBeGreaterThan(10);
            expect(response.body.excluded.data).toEqual(expect.arrayContaining([
                { dispatchId: ids.open, code: 'cutoff_window_open', detail: expect.any(String), routeBatchId: batchId, detailPath: `/dispatches/${ids.open}/detail` },
                { dispatchId: ids.none, code: 'cutoff_no_promise', detail: expect.any(String), routeBatchId: batchId, detailPath: `/dispatches/${ids.none}/detail` },
            ]));
        });

        it('takes the official cutoff of the day when none is asked for', async () => {
            const response = await coverage(`date=${shiftDate}&zoneId=${zoneId}`);
            expect(response.body.cutoff.official).toBe(true);
            expect(response.body.coverage.eligible).toBe(3);
        });

        it('filters by zone, warehouse and shift without ever using the batch as a filter', async () => {
            const otherZone = await coverage(`cutoffId=${scheduledId}&zoneId=${zoneId + 100000}`);
            expect(otherZone.body.coverage).toMatchObject({ eligible: 0, coveragePct: null });
            expect(otherZone.body.excluded.total).toBe(0);

            const wrongWarehouse = await coverage(`cutoffId=${scheduledId}&zoneId=${zoneId}&warehouseId=${warehouse.id + 100000}`);
            expect(wrongWarehouse.body.coverage.eligible).toBe(0);

            const rightWarehouse = await coverage(`cutoffId=${scheduledId}&zoneId=${zoneId}&warehouseId=${warehouse.id}`);
            expect(rightWarehouse.body.coverage.eligible).toBe(3);

            // The windows start at 08:00 La Paz: the morning.
            expect((await coverage(`cutoffId=${scheduledId}&zoneId=${zoneId}&shift=morning`)).body.coverage.eligible).toBe(3);
            expect((await coverage(`cutoffId=${scheduledId}&zoneId=${zoneId}&shift=afternoon`)).body.coverage.eligible).toBe(0);
        });

        it('has its own universe for the manual cutoff', async () => {
            const response = await coverage(`cutoffId=${manualId}&zoneId=${zoneId}`);
            expect(response.body.cutoff).toMatchObject({ id: manualId, triggerType: 'manual', official: false });
            expect(response.body.available).toBe(true);
        });

        it('is not available, and never rebuilt from current statuses, when there is no snapshot', async () => {
            const response = await coverage(`date=${EMPTY_DAY}`);
            expect(response.status).toBe(200);
            expect(response.body).toEqual({ date: EMPTY_DAY, available: false, reason: 'NO_SNAPSHOT', cutoff: null, coverage: null, excluded: null });
            expect((await get(`/planning/cutoffs?date=${EMPTY_DAY}`)).body.data).toEqual([]);
            expect((await coverage('cutoffId=2147483647')).body).toMatchObject({ available: false, reason: 'NO_SNAPSHOT' });
        });

        it('is not available when the day has only manual runs and no cutoff is asked for', async () => {
            await dataSource.query(
                `INSERT INTO planning_cutoffs (shift_date, cutoff_at, operating_timezone, trigger_type) VALUES ($1::date, NOW(), 'America/La_Paz', 'manual')`,
                [MANUAL_ONLY_DAY],
            );
            expect((await coverage(`date=${MANUAL_ONLY_DAY}`)).body).toMatchObject({ available: false, reason: 'NO_OFFICIAL_SNAPSHOT' });
        });

        it('rejects invalid filters with 400 and is closed to the supervisor', async () => {
            expect((await coverage('date=2026-13-45')).status).toBe(400);
            expect((await coverage('shift=night')).status).toBe(400);
            expect((await coverage('cutoffId=0')).status).toBe(400);
            expect((await get('/planning/cutoffs/coverage', supervisorToken)).status).toBe(403);
            expect((await get('/planning/cutoffs', supervisorToken)).status).toBe(403);
            expect((await get('/planning/route-completion', supervisorToken)).status).toBe(403);
            expect((await request(app.getHttpServer()).get(api('/planning/cutoffs'))).status).toBe(401);
        });
    });

    describe('from the second approval to the end of the route', () => {
        let routeBatchId = 0;
        let approvedBatchVersion = 0;
        let cancelled = 0;
        let scheduledId = 0;

        const eligibleIds = () => [ids.firm, ids.elapsedA, ids.elapsedB];

        it('freezes the confirmed manifest when the coordinator approves the route, and the coverage moves with it', async () => {
            scheduledId = (await cutoffRowOf(ids.firm, 'scheduled'))!;
            const [batch] = await dataSource.query(`SELECT route_batch_id AS id, status, version FROM route_batches WHERE route_batch_id = $1`, [batchId]);
            expect(batch.status).toBe('pending_final_review');
            routeBatchId = batch.id;
            const dispatches = await dataSource.query(`SELECT dispatch_id AS id, version FROM dispatches WHERE route_batch_id = $1 ORDER BY sequence_order`, [routeBatchId]);
            expect(dispatches.map((d: { id: number }) => d.id).sort()).toEqual(eligibleIds().sort());

            const response = await post(`/route-batches/${routeBatchId}/approve-final`, {
                version: batch.version,
                dispatches: dispatches.map((d: { id: number; version: number }) => ({ dispatchId: d.id, version: d.version })),
            });
            expect(response.status).toBe(200);
            approvedBatchVersion = response.body.version;

            const [manifest] = await dataSource.query(`SELECT route_manifest_id AS id, manifest_version, kind, route_version, vehicle_id, driver_id FROM route_manifests WHERE route_batch_id = $1`, [routeBatchId]);
            expect(manifest).toMatchObject({ manifest_version: 1, kind: 'confirmed', route_version: approvedBatchVersion, driver_id: driverId });
            const stops = await dataSource.query(`SELECT dispatch_id, stop_state, exclusion_code FROM route_manifest_stops WHERE route_manifest_id = $1 ORDER BY sequence_order`, [manifest.id]);
            expect(stops).toHaveLength(3);
            expect(stops.every((s: { stop_state: string; exclusion_code: string | null }) => s.stop_state === 'planned' && s.exclusion_code === null)).toBe(true);

            const covered = await coverage(`cutoffId=${scheduledId}&zoneId=${zoneId}`);
            expect(covered.body.coverage).toEqual({ eligible: 3, confirmed: 3, pending: 0, coveragePct: 100, confirmedOutsideUniverse: 0 });
        });

        it('shows a route that has not started as unknown, not as finished', async () => {
            const response = await get(`/planning/route-completion?date=${shiftDate}&zoneId=${zoneId}`);
            expect(response.status).toBe(200);
            expect(response.body.data).toEqual([]);
            // A confirmed route is not running yet: it is not "unknown", it simply has no baseline to measure.
            expect(response.body.unknownRouteBatchIds).not.toContain(routeBatchId);
            expect(response.body.summary).toMatchObject({ routesWithBaseline: 0, departed: 0, finalizedPct: null });
        });

        it('freezes the started manifest apart from a stop that was cancelled before the route left', async () => {
            // One confirmed stop is cancelled before the start: it leaves the batch, so it is in the confirmed manifest and not in the started one.
            cancelled = ids.elapsedB;
            await dataSource.query(
                `UPDATE dispatches SET route_batch_id = NULL, sequence_order = NULL, dispatch_status_id = $2, version = version + 1 WHERE dispatch_id = $1`,
                [cancelled, statusId['cancelled']],
            );
            await dataSource.transaction(async (manager) => {
                await manager.query(`UPDATE route_batches SET status = 'in_execution', accepted_at = NOW(), version = version + 1 WHERE route_batch_id = $1`, [routeBatchId]);
                await app.get(RouteManifestService).record(manager, { routeBatchId, kind: 'started', actorUserId: driverId, excludedDispatchIds: [] });
            });

            const started = await dataSource.query(
                `SELECT m.manifest_version, m.kind, array_agg(s.dispatch_id ORDER BY s.dispatch_id) AS dispatch_ids
                   FROM route_manifests m JOIN route_manifest_stops s USING (route_manifest_id)
                  WHERE m.route_batch_id = $1 AND m.kind = 'started' GROUP BY m.route_manifest_id`,
                [routeBatchId],
            );
            expect(started).toHaveLength(1);
            expect(started[0].manifest_version).toBe(2);
            expect(started[0].dispatch_ids).toEqual([ids.firm, ids.elapsedA].sort((a, b) => a - b));
            // A second started manifest of the same batch is refused by the database.
            await expect(dataSource.transaction((manager) => app.get(RouteManifestService).record(manager, { routeBatchId, kind: 'started', actorUserId: driverId, excludedDispatchIds: [] }))).rejects.toThrow(/uq_route_manifests_started/);
        });

        it('measures the completion over the frozen baseline, each stop in one category, with the batch only as detail', async () => {
            const response = await get(`/planning/route-completion?date=${shiftDate}&zoneId=${zoneId}`);

            expect(response.status).toBe(200);
            expect(response.body.summary).toMatchObject({ routesWithBaseline: 1, routesUnknown: 0, departed: 2, finalized: 0, finalizedPct: 0 });
            const [route] = response.body.data;
            expect(route).toMatchObject({ routeBatchId, manifestVersion: 2, departed: 2, finalized: 0, vehicle: { name: expect.any(String) }, driver: { id: driverId } });
            expect(route.counts).toEqual({ delivered: 0, pickupCompleted: 0, unsuccessful: 0, pending: 2, excludedAtStart: 0, cancelledBeforeStart: 1, removedBeforeStart: 0 });
            expect(route.stops.map((s: { dispatchId: number; outcome: string }) => [s.dispatchId, s.outcome])).toEqual(
                expect.arrayContaining([[ids.firm, 'pending'], [ids.elapsedA, 'pending'], [cancelled, 'cancelled_before_start']]),
            );
        });

        it('keeps the same denominator while the route advances, and shows each result without waiting for the batch to close', async () => {
            await dataSource.query(`UPDATE dispatches SET dispatch_status_id = $2 WHERE dispatch_id = $1`, [ids.firm, statusId['delivered']]);
            const midway = await get(`/planning/route-completion?date=${shiftDate}&zoneId=${zoneId}`);
            expect(midway.body.data[0].counts).toMatchObject({ delivered: 1, pending: 1, cancelledBeforeStart: 1 });
            expect(midway.body.summary).toMatchObject({ departed: 2, finalized: 1, finalizedPct: 50 });
            expect(midway.body.data[0].stops.find((s: { dispatchId: number }) => s.dispatchId === ids.firm).outcome).toBe('delivered');

            await dataSource.query(`UPDATE dispatches SET dispatch_status_id = $2 WHERE dispatch_id = $1`, [ids.elapsedA, statusId['not_delivered']]);
            const done = await get(`/planning/route-completion?date=${shiftDate}&zoneId=${zoneId}`);
            expect(done.body.data[0].counts).toEqual({ delivered: 1, pickupCompleted: 0, unsuccessful: 1, pending: 0, excludedAtStart: 0, cancelledBeforeStart: 1, removedBeforeStart: 0 });
            expect(done.body.summary).toMatchObject({ departed: 2, finalized: 2, finalizedPct: 100 });
            expect(done.body.data[0].stops).toHaveLength(3);
            expect((await dataSource.query(`SELECT status FROM route_batches WHERE route_batch_id = $1`, [routeBatchId]))[0].status).toBe('in_execution');
        });

        it('gives the same coverage denominator after the route advanced, changed batch and was cancelled in part', async () => {
            const covered = await coverage(`cutoffId=${scheduledId}&zoneId=${zoneId}`);
            expect(covered.body.coverage).toEqual({ eligible: 3, confirmed: 3, pending: 0, coveragePct: 100, confirmedOutsideUniverse: 0 });
            expect(covered.body.excluded.total).toBe(2);
        });

        it('writes a revised manifest, with its reason, when a stop leaves a route that already left', async () => {
            await dataSource.transaction(async (manager) => {
                await app.get(RouteManifestService).record(manager, { routeBatchId, kind: 'revised', actorUserId: coordinatorId, reason: 'E2E-REASSIGNMENT' });
            });
            const manifests = await dataSource.query(`SELECT manifest_version, kind, reason FROM route_manifests WHERE route_batch_id = $1 ORDER BY manifest_version`, [routeBatchId]);
            expect(manifests.map((m: { manifest_version: number; kind: string }) => [m.manifest_version, m.kind])).toEqual([[1, 'confirmed'], [2, 'started'], [3, 'revised']]);
            expect(manifests[2].reason).toBe('E2E-REASSIGNMENT');
            // The baseline did not move: the completion still reads the started manifest.
            const response = await get(`/planning/route-completion?date=${shiftDate}&zoneId=${zoneId}`);
            expect(response.body.data[0]).toMatchObject({ manifestVersion: 2 });
            await expect(dataSource.query(`UPDATE route_manifests SET kind = 'started' WHERE route_batch_id = $1`, [routeBatchId])).rejects.toThrow(/append-only/);
        });

        it('does not count as confirmed by this cutoff a confirmation written before it', async () => {
            // A dispatch of a new provisional batch that already has a confirmed manifest from yesterday: the cutoff finds it
            // eligible, but that confirmation is not the one that follows this cutoff, so it never enters the numerator.
            const made = await makeBatch(null as unknown as number, ['firm']);
            const [{ route_manifest_id }] = await dataSource.query(
                `INSERT INTO route_manifests (route_batch_id, manifest_version, kind, route_version, created_at)
                 VALUES ($1, 1, 'confirmed', 0, NOW() - INTERVAL '1 day') RETURNING route_manifest_id`,
                [made.batchId],
            );
            await dataSource.query(
                `INSERT INTO route_manifest_stops (route_manifest_id, dispatch_id, dispatch_type_id, sequence_order, stop_state)
                 VALUES ($1, $2, (SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'), 1, 'planned')`,
                [route_manifest_id, made.dispatchIds[0]],
            );
            const occurrence = `${scheduledOccurrence}-B`;
            const captured = await app.get(CutoffSnapshotService).capture({ shiftDate, now: new Date(), windowMinutes, manual: false, occurrence });

            const covered = await coverage(`cutoffId=${captured.planningCutoffId}&zoneId=${zoneId}`);

            expect(covered.body.coverage.eligible).toBeGreaterThanOrEqual(1);
            const item = await dataSource.query(`SELECT universe_status FROM planning_cutoff_dispatches WHERE planning_cutoff_id = $1 AND dispatch_id = $2`, [captured.planningCutoffId, made.dispatchIds[0]]);
            expect(item[0].universe_status).toBe('eligible');
            expect(covered.body.coverage.confirmed).toBe(0);
            // A second scheduled snapshot of the day never takes the place of the first one as the official cutoff.
            const list = await get(`/planning/cutoffs?date=${shiftDate}`);
            expect(list.body.data.find((c: { id: number }) => c.id === captured.planningCutoffId).official).toBe(false);
        });

        it('has no baseline for a day with no route that started, and rejects invalid filters', async () => {
            const empty = await get(`/planning/route-completion?date=${EMPTY_DAY}`);
            expect(empty.body).toEqual({
                date: EMPTY_DAY,
                summary: {
                    routesWithBaseline: 0, routesUnknown: 0, departed: 0, finalized: 0, finalizedPct: null,
                    counts: { delivered: 0, pickupCompleted: 0, unsuccessful: 0, pending: 0, excludedAtStart: 0, cancelledBeforeStart: 0, removedBeforeStart: 0 },
                },
                data: [],
                unknownRouteBatchIds: [],
            });
            expect((await get('/planning/route-completion?shift=night')).status).toBe(400);
            expect((await get('/planning/route-completion?zoneId=abc')).status).toBe(400);
        });

        it('reads a route that started with no manifest as unknown instead of rebuilding it', async () => {
            const [{ route_batch_id }] = await dataSource.query(
                `INSERT INTO route_batches (status, version, shift_date, delivery_zone_id, origin_warehouse_id) VALUES ('in_execution', 1, $1::date, $2, $3) RETURNING route_batch_id`,
                [shiftDate, zoneId, warehouse.id],
            );
            scope.batchIds.add(route_batch_id);

            const response = await get(`/planning/route-completion?date=${shiftDate}&zoneId=${zoneId}`);

            expect(response.body.unknownRouteBatchIds).toEqual([route_batch_id]);
            expect(response.body.summary).toMatchObject({ routesWithBaseline: 1, routesUnknown: 1 });
        });
    });
});
