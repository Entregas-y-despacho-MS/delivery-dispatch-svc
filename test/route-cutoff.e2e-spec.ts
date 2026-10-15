// ST-51.3 — Corte de D-1 (POST /planning/cutoff) de punta a punta.
//
// Levanta el AppModule real contra una base de datos real, con OSRM simulado (FakeOsrm) y la lectura de
// lotes, vehículos y conductores acotada a lo que crea esta corrida, para no tocar datos de otros suites
// ni de otras personas. Todo lo que crea lleva un prefijo único y se borra en afterAll; las claves
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
import { PlanCandidatesRepository } from '../src/app/planning/services/plan-candidates.repository.js';
import { FakeOsrm } from '../src/app/planning/domain/plan-fixtures.helper-spec.js';
import { localDate, localInstant, nextOperatingDay } from '../src/app/planning/domain/operating-calendar.js';
import { loadPlanningSettings } from '../src/app/planning/domain/planning-settings.js';
import { SCHEDULED_TASK_RUN_ACTION } from '../src/app/scheduler/adapters/audit-log-task-run-log.adapter.js';
import { PLAN_ALERT_ACTION } from '../src/app/planning/services/planning-alerts.service.js';
import { CutoffBatchesRepository } from '../src/app/route-cutoff/services/cutoff-batches.repository.js';
import { RouteCutoffWriterService } from '../src/app/route-cutoff/services/route-cutoff-writer.service.js';
import { reoptimizeCutoff } from '../src/app/route-cutoff/domain/cutoff-reoptimization.js';
import { splitPlanByGroup } from '../src/app/route-cutoff/domain/cutoff-groups.js';
import { buildSimParams } from '../src/app/route-cutoff/domain/cutoff-sim-params.js';
import type { CutoffStop } from '../src/app/route-cutoff/domain/cutoff-types.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

type Kind = 'firm' | 'elapsed' | 'open' | 'none';
interface StopSpec {
    km: number;
    window: [string, string];
    kind?: Kind;
    packages?: boolean;
    kg?: number;
}

describe('Route cutoff (e2e, ST-51.3)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const startedAt = new Date();
    const run = Date.now().toString(36).toUpperCase();
    const refPrefix = `E2ECUT-${run}-`;
    const userPrefix = 'e2e_cut_';

    const fakeOsrm = new FakeOsrm();
    const scope = {
        dispatchIds: new Set<number>(),
        batchIds: new Set<number>(),
        vehicleIds: new Set<number>(),
        zoneIds: [] as number[],
    };
    const originalSettings: Record<string, string> = {};
    let coordinatorToken = '';
    let warehouse = { id: 0, lat: 0, lon: 0 };
    let statusId: Record<string, number> = {};
    let driverIds: number[] = [];
    let coordinatorId = 0;
    let shiftDate = '';
    let windowMinutes = 720;
    let seq = 0;
    let driverCursor = 0;

    // A test may look at its own batches only: another provisional batch would compete for its vehicles.
    let focusBatches: Set<number> | null = null;
    class ScopedBatches extends CutoffBatchesRepository {
        async findProvisionalBatches(date: string) {
            const read = await super.findProvisionalBatches(date);
            const allowed = focusBatches ?? scope.batchIds;
            return {
                batches: read.batches.filter((b) => allowed.has(b.routeBatchId)),
                skippedBatchIds: read.skippedBatchIds.filter((id) => allowed.has(id)),
            };
        }
    }
    // A test may narrow the fleet to its own vehicles: vehicles freed by an earlier test would be free here.
    let fleetOverride: Set<number> | null = null;
    class ScopedCandidates extends PlanCandidatesRepository {
        async findVehicles() {
            const allowed = fleetOverride ?? scope.vehicleIds;
            return (await super.findVehicles()).filter((v) => allowed.has(v.vehicleId));
        }
    }

    const api = (path: string) => `/${apiPrefix}${path}`;
    const auth = () => ({ Authorization: `Bearer ${coordinatorToken}` });
    const cutoff = () => request(app.getHttpServer()).post(api('/planning/cutoff')).set(auth());
    const putSetting = (key: string, value: string) =>
        request(app.getHttpServer()).put(api(`/settings/${key}`)).set(auth()).send({ value });

    const newZone = async (): Promise<number> => {
        const [{ delivery_zone_id }] = await dataSource.query(
            `INSERT INTO delivery_zones (code, name, estimated_time_min) VALUES ($1, $2, 30) RETURNING delivery_zone_id`,
            [`CU${run}${scope.zoneIds.length}`.slice(0, 20), `Zona e2e corte ${run} ${scope.zoneIds.length}`],
        );
        scope.zoneIds.push(delivery_zone_id);
        return delivery_zone_id as number;
    };

    const newVehicle = async (capacityKg: number): Promise<number> => {
        const [{ vehicle_status_id }] = await dataSource.query(`SELECT vehicle_status_id FROM vehicle_statuses WHERE name = 'active'`);
        const [{ vehicle_id }] = await dataSource.query(
            `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3)
             VALUES ($1, 'camioneta', 'E2E corte', $2, $3, 50) RETURNING vehicle_id`,
            [vehicle_status_id, `C${run}${scope.vehicleIds.size}`.slice(0, 15), capacityKg],
        );
        scope.vehicleIds.add(vehicle_id);
        return vehicle_id as number;
    };

    /** A provisional batch of the route day with its stops; the kind decides the state of each promise. */
    const makeBatch = async (zoneId: number, vehicleId: number | null, stops: StopSpec[]) => {
        const driverId = driverIds[driverCursor++ % driverIds.length];
        const [{ route_batch_id }] = await dataSource.query(
            `INSERT INTO route_batches (status, version, shift_date, delivery_zone_id, origin_warehouse_id, vehicle_id,
                                        proposed_driver_id, reviewer_user_id)
             VALUES ('provisional', 2, $1::date, $2, $3, $4, $5, $6) RETURNING route_batch_id`,
            [shiftDate, zoneId, warehouse.id, vehicleId, driverId, coordinatorId],
        );
        scope.batchIds.add(route_batch_id);
        const minute = 60_000;
        const dispatchIds: number[] = [];
        for (const [index, spec] of stops.entries()) {
            const kind = spec.kind ?? 'elapsed';
            const now = Date.now();
            const notifiedAt = kind === 'open' ? new Date(now - 10 * minute)
                : kind === 'elapsed' ? new Date(now - (windowMinutes + 60) * minute)
                : kind === 'firm' ? new Date(now - (windowMinutes + 120) * minute) : null;
            const firmedAt = kind === 'firm' ? new Date(now - 60 * minute) : null;
            const [{ dispatch_id }] = await dataSource.query(
                `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, delivery_zone_id, origin_warehouse_id, source_order_ref,
                                         delivery_address, delivery_latitude, delivery_longitude, estimated_weight_kg,
                                         order_confirmed_at, shipment_ready, route_batch_id, sequence_order,
                                         scheduled_window_start, scheduled_window_end, promise_notified_at,
                                         promise_firmed_at, version)
                 VALUES ((SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'), $1, $2, $3, $4,
                         'Dirección de prueba', $5, $6, $7, NOW(), TRUE, $8, $9, $10, $11, $12, $13, 1)
                 RETURNING dispatch_id`,
                [statusId[kind === 'none' ? 'in_planning' : 'scheduled'], zoneId, warehouse.id, `${refPrefix}${++seq}`,
                 warehouse.lat - spec.km * 0.01, warehouse.lon, spec.kg ?? 10, route_batch_id, index + 1,
                 localInstant(shiftDate, spec.window[0]), localInstant(shiftDate, spec.window[1]), notifiedAt, firmedAt],
            );
            scope.dispatchIds.add(dispatch_id);
            dispatchIds.push(dispatch_id);
            if (spec.packages !== false) {
                await dataSource.query(
                    `INSERT INTO dispatch_packages (dispatch_id, external_package_id, length_cm, width_cm, height_cm, gross_weight_kg)
                     VALUES ($1, $2, 20, 20, 20, $3)`,
                    [dispatch_id, `PKG-${dispatch_id}`, spec.kg ?? 10],
                );
            }
        }
        return { batchId: route_batch_id as number, dispatchIds };
    };

    const batchRow = async (id: number) => (await dataSource.query(
        `SELECT status, version, vehicle_id, proposed_driver_id, delivery_zone_id, shift_date::text AS shift_date
           FROM route_batches WHERE route_batch_id = $1`, [id]))[0];
    const dispatchRow = async (id: number) => (await dataSource.query(
        `SELECT s.name AS status, d.route_batch_id, d.sequence_order, d.version,
                d.scheduled_window_start, d.scheduled_window_end
           FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id) WHERE d.dispatch_id = $1`, [id]))[0];
    const eventsOf = async (batchId: number) => await dataSource.query(
        `SELECT event_type, reason, dispatch_id, metadata FROM route_batch_events WHERE route_batch_id = $1 ORDER BY route_batch_event_id`,
        [batchId]);
    const batchesOfZone = async (zoneId: number) => (await dataSource.query(
        `SELECT route_batch_id AS id, status, vehicle_id FROM route_batches WHERE delivery_zone_id = $1 ORDER BY route_batch_id`,
        [zoneId]));

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(OsrmPort).useValue(fakeOsrm)
            .overrideProvider(CutoffBatchesRepository)
            .useFactory({ factory: (ds: DataSource) => new ScopedBatches(ds), inject: [DataSource] })
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
                [roles[role], `Corte ${key} ${run}`, `${userPrefix}${key}_${run}`, passwordHash],
            );
            return user_id as number;
        };
        coordinatorId = await makeUser('coordinator', 'coordinator');
        for (let i = 0; i < 8; i++) driverIds.push(await makeUser(`driver${i}`, 'driver'));
        const login = await request(app.getHttpServer()).post(api('/auth/login'))
            .send({ username: `${userPrefix}coordinator_${run}`, password: 'E2eTest1234' });
        coordinatorToken = login.body.accessToken as string;

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
        // A manual cutoff always works on the next operating day, as the service does.
        shiftDate = nextOperatingDay(localDate(new Date()), loaded.values!.calendar);
    });

    afterAll(async () => {
        for (const [key, value] of Object.entries(originalSettings)) {
            await dataSource.query(`UPDATE settings SET setting_value = $1 WHERE setting_key = $2`, [value, key]);
        }
        const batchIds: number[] = scope.zoneIds.length
            ? (await dataSource.query(
                `SELECT route_batch_id AS id FROM route_batches WHERE delivery_zone_id = ANY($1::int[])`, [scope.zoneIds],
            )).map((r: { id: number }) => r.id)
            : [];
        await withEventPurge(dataSource, { dispatchRefs: [`${refPrefix}%`], routeBatchIds: batchIds, userNames: [`${userPrefix}%_${run}`] });
        await dataSource.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${refPrefix}%`]);
        if (batchIds.length) await dataSource.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
        if (scope.vehicleIds.size) {
            await dataSource.query(`DELETE FROM vehicles WHERE vehicle_id = ANY($1::int[])`, [[...scope.vehicleIds]]);
        }
        if (scope.zoneIds.length) {
            await dataSource.query(`DELETE FROM delivery_zones WHERE delivery_zone_id = ANY($1::int[])`, [scope.zoneIds]);
        }
        await dataSource.query(
            `DELETE FROM audit_logs WHERE created_at >= $1 AND (action = $2 OR (action = $3 AND detail LIKE '%"trigger":"manual"%'))`,
            [startedAt, PLAN_ALERT_ACTION, SCHEDULED_TASK_RUN_ACTION],
        );
        await dataSource.query(`DELETE FROM users WHERE username LIKE $1`, [`${userPrefix}%_${run}`]);
        await app?.close();
    });

    it('merges two batches of the zone without moving any promised slot', async () => {
        const zone = await newZone();
        const vehicleA = await newVehicle(1000);
        const vehicleB = await newVehicle(1000);
        const a = await makeBatch(zone, vehicleA, [
            { km: 1, window: ['09:00', '11:00'], kind: 'elapsed' },
            { km: 2, window: ['11:00', '13:00'], kind: 'firm' },
        ]);
        const b = await makeBatch(zone, vehicleB, [{ km: 3, window: ['14:00', '16:00'], kind: 'elapsed' }]);
        const windowsBefore = await Promise.all([...a.dispatchIds, ...b.dispatchIds].map(async (id) => {
            const row = await dispatchRow(id);
            return [id, row.scheduled_window_start.getTime(), row.scheduled_window_end.getTime()];
        }));

        const res = await cutoff();

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ task: 'route-cutoff', status: 'executed' });
        expect(res.body.summary.shiftDate).toBe(shiftDate);
        expect(res.body.summary.pendingFinalReviewBatchIds).toContain(a.batchId);
        expect(res.body.summary.cancelledBatchIds).toContain(b.batchId);

        const survivor = await batchRow(a.batchId);
        expect(survivor.status).toBe('pending_final_review');
        expect([vehicleA, vehicleB]).toContain(survivor.vehicle_id);
        expect(survivor.version).toBeGreaterThan(2);
        expect((await batchRow(b.batchId)).status).toBe('cancelled');

        for (const id of [...a.dispatchIds, ...b.dispatchIds]) {
            const row = await dispatchRow(id);
            expect(row.route_batch_id).toBe(a.batchId);
            expect(row.status).toBe('scheduled');
        }
        const sequences = (await Promise.all([...a.dispatchIds, ...b.dispatchIds].map(dispatchRow))).map((r) => r.sequence_order);
        expect([...sequences].sort()).toEqual([1, 2, 3]);
        for (const [id, start, end] of windowsBefore) {
            const row = await dispatchRow(id as number);
            expect([row.scheduled_window_start.getTime(), row.scheduled_window_end.getTime()]).toEqual([start, end]);
        }

        const survivorEvents = (await eventsOf(a.batchId)).map((e: { event_type: string }) => e.event_type);
        expect(survivorEvents).toEqual(expect.arrayContaining(['merged', 'cutoff_validated']));
        expect((await eventsOf(b.batchId)).map((e: { event_type: string }) => e.event_type)).toContain('cancelled');
    });

    it('sends a batch that fails validation back to provisional with its reasons', async () => {
        const zone = await newZone();
        const vehicle = await newVehicle(1000);
        const batch = await makeBatch(zone, vehicle, [
            { km: 1, window: ['09:00', '11:00'], kind: 'firm' },
            { km: 2, window: ['11:00', '13:00'], kind: 'firm', packages: false },
        ]);
        const before = await batchRow(batch.batchId);

        const res = await cutoff();

        expect(res.status).toBe(200);
        const failed = res.body.summary.failedBatches.find((f: { routeBatchId: number }) => f.routeBatchId === batch.batchId);
        expect(failed.reasons).toEqual(['packages_missing']);
        expect(res.body.summary.pendingFinalReviewBatchIds).not.toContain(batch.batchId);

        const after = await batchRow(batch.batchId);
        expect(after.status).toBe('provisional');
        expect(after.version).toBe(before.version);
        const events = await eventsOf(batch.batchId);
        const failure = events.find((e: { event_type: string }) => e.event_type === 'cutoff_failed');
        expect(failure.reason).toBe('packages_missing');
        expect(failure.metadata.failures[0]).toMatchObject({ code: 'packages_missing', dispatchIds: [batch.dispatchIds[1]] });
    });

    it('keeps out the order whose window is still open and releases the one without promise', async () => {
        const zone = await newZone();
        const vehicle = await newVehicle(1000);
        const batch = await makeBatch(zone, vehicle, [
            { km: 1, window: ['09:00', '11:00'], kind: 'firm' },
            { km: 2, window: ['11:00', '13:00'], kind: 'open' },
            { km: 3, window: ['14:00', '16:00'], kind: 'none' },
        ]);
        const [firm, open, none] = batch.dispatchIds;
        const openBefore = await dispatchRow(open);

        const res = await cutoff();

        expect(res.status).toBe(200);
        expect(res.body.summary.pendingFinalReviewBatchIds).toContain(batch.batchId);
        expect(res.body.summary.releasedDispatchIds).toContain(none);
        expect(res.body.summary.remnantBatchIds).toHaveLength(1);

        expect((await batchRow(batch.batchId)).status).toBe('pending_final_review');
        expect((await dispatchRow(firm)).route_batch_id).toBe(batch.batchId);

        // The order with an open window waits in a remnant: provisional, no vehicle, promise intact.
        const [remnantId] = res.body.summary.remnantBatchIds as number[];
        const remnant = await batchRow(remnantId);
        expect(remnant).toMatchObject({ status: 'provisional', vehicle_id: null, delivery_zone_id: zone, shift_date: shiftDate });
        const openAfter = await dispatchRow(open);
        expect(openAfter).toMatchObject({ status: 'scheduled', route_batch_id: remnantId, sequence_order: 1 });
        expect(openAfter.scheduled_window_start.getTime()).toBe(openBefore.scheduled_window_start.getTime());
        expect(openAfter.scheduled_window_end.getTime()).toBe(openBefore.scheduled_window_end.getTime());

        // The order never approved goes back to the pool of the generator.
        expect(await dispatchRow(none)).toMatchObject({ status: 'pending', route_batch_id: null, sequence_order: null });

        const reasons = (await eventsOf(batch.batchId))
            .filter((e: { event_type: string }) => e.event_type === 'order_removed')
            .map((e: { reason: string }) => e.reason);
        expect(reasons.sort()).toEqual(['cutoff_no_promise', 'cutoff_window_open']);
    });

    it('divides a batch that no longer fits its vehicle into a new batch with a free one', async () => {
        const zone = await newZone();
        const small = await newVehicle(100);
        const spare = await newVehicle(100);
        const batch = await makeBatch(zone, small, [
            { km: 1, window: ['09:00', '11:00'], kind: 'firm', kg: 60 },
            { km: 2, window: ['11:00', '13:00'], kind: 'firm', kg: 60 },
        ]);

        fleetOverride = new Set([small, spare]);
        focusBatches = new Set([batch.batchId]);
        let res: request.Response;
        try {
            res = await cutoff();
        } finally {
            fleetOverride = null;
            focusBatches = null;
        }

        expect(res.status).toBe(200);
        expect(res.body.summary.createdBatchIds).toHaveLength(1);
        const [newId] = res.body.summary.createdBatchIds as number[];
        expect(res.body.summary.pendingFinalReviewBatchIds).toEqual(expect.arrayContaining([batch.batchId, newId]));

        const original = await batchRow(batch.batchId);
        const created = await batchRow(newId);
        expect([original.status, created.status]).toEqual(['pending_final_review', 'pending_final_review']);
        expect(original.vehicle_id).toBe(small);
        expect(created.vehicle_id).toBe(spare);
        expect((await dispatchRow(batch.dispatchIds[0])).route_batch_id).toBe(batch.batchId);
        expect((await dispatchRow(batch.dispatchIds[1])).route_batch_id).toBe(newId);

        expect((await eventsOf(batch.batchId)).map((e: { event_type: string }) => e.event_type)).toContain('split');
        expect((await eventsOf(newId)).map((e: { event_type: string }) => e.event_type)).toContain('created');
    });

    it('leaves a batch that already left provisional untouched when the cutoff runs again', async () => {
        const zones = scope.zoneIds.slice(0, 4);
        const before = await Promise.all(zones.map(batchesOfZone));
        const events = await dataSource.query(`SELECT COUNT(*)::int AS n FROM route_batch_events WHERE route_batch_id = ANY($1::int[])`, [[...scope.batchIds]]);

        const res = await cutoff();

        expect(res.status).toBe(200);
        const after = await Promise.all(zones.map(batchesOfZone));
        // Zone 2 (failed validation) is processed again and stays as it was; the others are not read at all.
        expect(after).toEqual(before);
        expect(res.body.summary.createdBatchIds).toEqual([]);
        expect(res.body.summary.releasedDispatchIds).toEqual([]);
        expect(events[0].n).toBeGreaterThan(0);
    });

    it('drops the whole group when an order changed while the cutoff was computing', async () => {
        const zone = await newZone();
        const vehicle = await newVehicle(1000);
        const batch = await makeBatch(zone, vehicle, [
            { km: 1, window: ['09:00', '11:00'], kind: 'firm' },
            { km: 2, window: ['11:00', '13:00'], kind: 'firm' },
        ]);
        const before = await batchRow(batch.batchId);

        // Read and plan like the service does...
        const read = await app.get(CutoffBatchesRepository).findProvisionalBatches(shiftDate);
        const mine = read.batches.filter((b) => b.routeBatchId === batch.batchId);
        const settings = (await loadPlanningSettings(app.get(SettingsService))).values!;
        const plan = reoptimizeCutoff({
            now: new Date(),
            settings,
            batches: mine,
            fleet: await app.get(PlanCandidatesRepository).findVehicles(),
            occupiedVehicleIds: [],
            maxStopsPerBatch: 50,
            travelFor: () => () => 60,
        });
        const [group] = splitPlanByGroup(plan, mine);
        const stopsById = new Map<number, CutoffStop>(mine.flatMap((b) => b.stops).map((s) => [s.dispatch.dispatchId, s]));

        // ...and somebody changes an order before the group is written.
        await dataSource.query(`UPDATE dispatches SET version = version + 1 WHERE dispatch_id = $1`, [batch.dispatchIds[0]]);

        const result = await app.get(RouteCutoffWriterService).applyGroup(group, {
            trigger: 'manual',
            occurrence: null,
            fleet: await app.get(PlanCandidatesRepository).findVehicles(),
            params: buildSimParams(settings, () => 60),
            stopsById,
        });

        expect(result.status).toBe('stale');
        expect(result.staleReasons.map((r) => r.code)).toEqual(['dispatch_version_changed']);
        const after = await batchRow(batch.batchId);
        expect(after).toMatchObject({ status: 'provisional', version: before.version });
        expect((await dispatchRow(batch.dispatchIds[0])).route_batch_id).toBe(batch.batchId);
        const failure = (await eventsOf(batch.batchId)).find((e: { event_type: string }) => e.event_type === 'cutoff_failed');
        expect(failure.metadata.stale).toBe(true);
    });
});
