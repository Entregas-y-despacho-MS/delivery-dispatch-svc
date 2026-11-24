// ST-302.4 — Cohorte, carga y finalización de ruta después de una replanificación real.
//
// Qué agrega frente a test/planning-snapshots.e2e-spec.ts (ST-302.2): aquel congela el universo llamando a
// `CutoffSnapshotService.capture` y simula la cancelación previa y la ruta en ejecución con UPDATE directos. Esta suite
// recorre el flujo real de punta a punta y mira que el denominador no se mueva:
//   - corte programado completo (`RouteCutoffService.run` con trigger `schedule` y occurrence propia), que congela y
//     reorganiza: lote remanente nuevo, despacho liberado sin promesa;
//   - replanificación después del corte: cancelación por POST /dispatches/:id/cancel (el despacho sale del lote),
//     promesa firmada por el cliente, corte manual por POST /planning/cutoff y repetición de la misma occurrence;
//   - segunda aprobación, aceptación y salida de ruta por la API (manifiestos confirmed/started reales);
//   - reprogramación antes de salir y en ejecución por POST /dispatches/:id/reschedule, cancelación de una parada
//     confirmada por el endpoint (sale del lote y cuenta como cancelada antes de salir), y transiciones del repartidor por PATCH /dispatches/:id/status;
//   - paradas reasignadas entre dos rutas en ejecución por POST /route-batches/:id/reassign;
//   - que ninguna respuesta exponga una duración que no existe, ni datos del cliente.
// Las cifras esperadas salen de la tabla de casos de referencia (CASES), resuelta a mano parada por parada.
// La capacidad kg/m³ por separado, las etapas excluyentes y la paginación ya las prueba test/planning-pipeline.e2e-spec.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { OsrmPort } from '../src/plugins/osrm/osrm.port.js';
import { PlanCandidatesRepository } from '../src/app/planning/services/plan-candidates.repository.js';
import { FakeOsrm } from '../src/app/planning/domain/plan-fixtures.helper-spec.js';
import { addDays, localDate, localInstant, nextOperatingDay, previousOperatingDay } from '../src/app/planning/domain/operating-calendar.js';
import { loadPlanningSettings } from '../src/app/planning/domain/planning-settings.js';
import { SettingsService } from '../src/modules/settings/services/settings.service.js';
import { buildTimeSlots } from '../src/app/planning/domain/time-slots.js';
import { CutoffBatchesRepository } from '../src/app/route-cutoff/services/cutoff-batches.repository.js';
import { RouteCutoffService } from '../src/app/route-cutoff/services/route-cutoff.service.js';
import { PromiseFirmingService } from '../src/app/promise-firming/services/promise-firming.service.js';
import { SCHEDULED_TASK_RUN_ACTION } from '../src/app/scheduler/adapters/audit-log-task-run-log.adapter.js';
import { PLAN_ALERT_ACTION } from '../src/app/planning/services/planning-alerts.service.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

type Kind = 'firm' | 'elapsed' | 'open' | 'none';
type Key = 'a1' | 'a2' | 'a3' | 'a4' | 'a5' | 'a7' | 'a8' | 'b1' | 'b2' | 'c1' | 'c2';
type Outcome = 'delivered' | 'unsuccessful' | 'pending' | 'removed_before_start' | 'cancelled_before_start' | 'excluded_at_start' | null;

/**
 * Casos de referencia, resueltos a mano. `universe`: lo que el corte programado tiene que congelar. `confirmed`: si entra
 * al numerador de ese corte (manifiesto confirmed posterior al corte). `outcome`: categoría final en la ruta donde cuenta
 * (`route`); `null` si nunca está en la línea base de una ruta iniciada.
 */
const CASES: Record<Key, { zone: 1 | 2 | 3; kind: Kind; universe: 'eligible' | 'excluded'; code: string | null; confirmed: boolean; route: 'A' | 'B' | 'C' | null; outcome: Outcome; story: string }> = {
    a1: { zone: 1, kind: 'firm', universe: 'eligible', code: null, confirmed: true, route: 'A', outcome: 'delivered', story: 'sale con A, se reasigna a B en ruta y B la entrega: cuenta en el origen A' },
    a2: { zone: 1, kind: 'elapsed', universe: 'eligible', code: null, confirmed: true, route: 'A', outcome: 'unsuccessful', story: 'no entregada en ruta y reprogramada por el coordinador' },
    a3: { zone: 1, kind: 'firm', universe: 'eligible', code: null, confirmed: false, route: null, outcome: null, story: 'cancelada después del corte y antes de la 2.ª aprobación: sale del lote' },
    a4: { zone: 1, kind: 'open', universe: 'excluded', code: 'cutoff_window_open', confirmed: false, route: null, outcome: null, story: 'ventana abierta: lote remanente; el cliente la firma y entra en el corte manual' },
    a5: { zone: 1, kind: 'none', universe: 'excluded', code: 'cutoff_no_promise', confirmed: false, route: null, outcome: null, story: 'nunca aprobada: el corte la devuelve a pending' },
    a7: { zone: 1, kind: 'firm', universe: 'eligible', code: null, confirmed: true, route: 'A', outcome: 'removed_before_start', story: 'confirmada y reprogramada antes de salir' },
    a8: { zone: 1, kind: 'firm', universe: 'eligible', code: null, confirmed: true, route: 'A', outcome: 'pending', story: 'sale con A y sigue abierta (mantiene A en ejecución)' },
    b1: { zone: 2, kind: 'firm', universe: 'eligible', code: null, confirmed: true, route: 'B', outcome: 'pending', story: 'sale con B, abierta' },
    b2: { zone: 2, kind: 'firm', universe: 'eligible', code: null, confirmed: true, route: 'B', outcome: 'unsuccessful', story: 'sale con B, no entregada' },
    c1: { zone: 3, kind: 'firm', universe: 'eligible', code: null, confirmed: true, route: 'C', outcome: 'pending', story: 'sale con C' },
    c2: { zone: 3, kind: 'firm', universe: 'eligible', code: null, confirmed: true, route: 'C', outcome: 'cancelled_before_start', story: 'confirmada y cancelada por el endpoint antes de salir: sale del lote' },
};

const KEYS = Object.keys(CASES) as Key[];
const ofZone = (zone: 1 | 2 | 3) => KEYS.filter((key) => CASES[key].zone === zone);

/** Cobertura esperada de un corte para una zona, calculada desde la tabla. */
function expectedCoverage(zone: 1 | 2 | 3) {
    const keys = ofZone(zone);
    const eligible = keys.filter((key) => CASES[key].universe === 'eligible');
    const confirmed = eligible.filter((key) => CASES[key].confirmed);
    return {
        eligible: eligible.length,
        confirmed: confirmed.length,
        pending: eligible.length - confirmed.length,
        coveragePct: eligible.length === 0 ? null : Math.round((confirmed.length / eligible.length) * 10000) / 100,
    };
}

/** Conteos esperados de una ruta, calculados desde la tabla. */
function expectedRoute(route: 'A' | 'B' | 'C') {
    const keys = KEYS.filter((key) => CASES[key].route === route);
    const count = (outcome: Outcome) => keys.filter((key) => CASES[key].outcome === outcome).length;
    const counts = {
        delivered: count('delivered'), pickupCompleted: 0, unsuccessful: count('unsuccessful'), pending: count('pending'),
        excludedAtStart: count('excluded_at_start'), cancelledBeforeStart: count('cancelled_before_start'), removedBeforeStart: count('removed_before_start'),
    };
    const departed = counts.delivered + counts.unsuccessful + counts.pending;
    const finalized = counts.delivered + counts.unsuccessful;
    return { keys, counts, departed, finalized, finalizedPct: departed === 0 ? null : Math.round((finalized / departed) * 10000) / 100 };
}

/** Recorre una respuesta y devuelve todas sus claves, a cualquier profundidad. */
function allKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
    if (Array.isArray(value)) value.forEach((item) => allKeys(item, out));
    else if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) { out.add(key); allKeys(inner, out); }
    return out;
}

describe('Planning cohort after replanning, load and route completion (e2e, ST-302.4)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const startedAt = new Date();
    const run = Date.now().toString(36).toUpperCase();
    const refPrefix = `E2EREPLAN-${run}-`;
    const userPrefix = 'e2e_replan_';
    const occurrence = `route-cutoff@E2E-REPLAN-${run}`;
    const reasonCode = `E2ERP${run}`.slice(0, 20);

    const fakeOsrm = new FakeOsrm();
    const scope = { vehicleIds: new Set<number>(), zoneIds: [] as number[], batchIds: new Set<number>(), cutoffIds: new Set<number>() };
    const originalSettings: Record<string, string> = {};
    const tokens: Record<'coordinator' | 'supervisor' | 'driverA' | 'driverB' | 'driverC', string> = { coordinator: '', supervisor: '', driverA: '', driverB: '', driverC: '' };
    const userIds: Record<string, number> = {};
    const id = {} as Record<Key, number>;
    const zone = {} as Record<1 | 2 | 3, number>;
    const batch = { A: 0, B: 0, C: 0, R: 0 };
    let reasonId = 0;
    let warehouse = { id: 0, lat: 0, lon: 0 };
    let statusId: Record<string, number> = {};
    let shiftDate = '';
    let windowMinutes = 720;
    let cutoffAt = new Date();
    let scheduledId = 0;
    let manualId = 0;
    let seq = 0;

    // El corte reorganiza solo los lotes de esta corrida y solo con sus vehículos.
    class ScopedBatches extends CutoffBatchesRepository {
        async findProvisionalBatches(date: string) {
            const read = await super.findProvisionalBatches(date);
            return {
                batches: read.batches.filter((b) => scope.batchIds.has(b.routeBatchId)),
                skippedBatchIds: read.skippedBatchIds.filter((bid) => scope.batchIds.has(bid)),
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
    const get = (path: string, token = tokens.coordinator) => request(app.getHttpServer()).get(api(path)).set(as(token));
    const post = (path: string, body: object = {}, token = tokens.coordinator) => request(app.getHttpServer()).post(api(path)).set(as(token)).send(body);
    const putSetting = (key: string, value: string) => request(app.getHttpServer()).put(api(`/settings/${key}`)).set(as(tokens.coordinator)).send({ value });
    const coverage = (query: string) => get(`/planning/cutoffs/coverage?${query}`);
    const completion = (query: string) => get(`/planning/route-completion?date=${shiftDate}&${query}`);

    let lastOccurredAt = Date.now();
    /**
     * Transición del repartidor por el endpoint real, con un instante siempre creciente. `evidence` es la referencia a
     * la evidencia POD ya registrada: `delivered` la exige.
     */
    const driverStatus = (token: string, dispatchId: number, status: 'in_transit' | 'delivered' | 'not_delivered', evidence?: { evidenceId: string; type: 'signature' | 'photo' | 'otp' }) => {
        lastOccurredAt = Math.max(lastOccurredAt + 1000, Date.now());
        return request(app.getHttpServer()).patch(api(`/dispatches/${dispatchId}/status`)).set(as(token))
            .send({ status, eventId: uuidv7(), occurredAt: new Date(lastOccurredAt).toISOString(), lat: -16.5, lng: -68.13, accuracy: 5, ...(evidence && { evidence }) });
    };

    const makeUser = async (key: string, role: string, roles: Record<string, number>, passwordHash: string): Promise<number> => {
        const [{ user_id }] = await dataSource.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change, active)
             VALUES ($1, $2, $3, $4, false, true) RETURNING user_id`,
            [roles[role], `Replan ${key} ${run}`, `${userPrefix}${key}_${run}`, passwordHash],
        );
        userIds[key] = user_id;
        return user_id as number;
    };
    const login = async (key: string): Promise<string> =>
        (await request(app.getHttpServer()).post(api('/auth/login')).send({ username: `${userPrefix}${key}_${run}`, password: 'E2eTest1234' })).body.accessToken as string;

    const makeVehicle = async (statusIdActive: number, tag: string): Promise<number> => {
        const [{ vehicle_id }] = await dataSource.query(
            `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3) VALUES ($1, 'camioneta', 'E2E replan', $2, 1000, 50) RETURNING vehicle_id`,
            [statusIdActive, `R${tag}${run}`.slice(0, 15)],
        );
        scope.vehicleIds.add(vehicle_id);
        return vehicle_id as number;
    };

    /** Lote provisional del día de ruta; el tipo de cada parada decide el estado de su promesa respecto del instante del corte. */
    const makeBatch = async (zoneId: number, vehicleId: number, driverId: number, keys: Key[]): Promise<number> => {
        const [{ route_batch_id }] = await dataSource.query(
            `INSERT INTO route_batches (status, version, shift_date, delivery_zone_id, origin_warehouse_id, vehicle_id, proposed_driver_id, reviewer_user_id)
             VALUES ('provisional', 2, $1::date, $2, $3, $4, $5, $6) RETURNING route_batch_id`,
            [shiftDate, zoneId, warehouse.id, vehicleId, driverId, userIds.coordinator],
        );
        scope.batchIds.add(route_batch_id);
        const minute = 60_000;
        const at = cutoffAt.getTime();
        for (const [index, key] of keys.entries()) {
            const kind = CASES[key].kind;
            const notifiedAt = kind === 'open' ? new Date(at - 10 * minute)
                : kind === 'elapsed' ? new Date(at - (windowMinutes + 60) * minute)
                : kind === 'firm' ? new Date(at - (windowMinutes + 120) * minute) : null;
            const firmedAt = kind === 'firm' ? new Date(at - 60 * minute) : null;
            const [{ dispatch_id }] = await dataSource.query(
                `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, delivery_zone_id, origin_warehouse_id, source_order_ref, tracking_code,
                                         delivery_address, delivery_latitude, delivery_longitude, estimated_weight_kg,
                                         order_confirmed_at, shipment_ready, route_batch_id, sequence_order,
                                         scheduled_window_start, scheduled_window_end, promise_notified_at, promise_firmed_at, version)
                 VALUES ((SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'), $1, $2, $3, $4, next_tracking_code(),
                         'Calle Privada 123, depto 4', $5, $6, 10, NOW(), TRUE, $7, $8, $9, $10, $11, $12, 1)
                 RETURNING dispatch_id`,
                [statusId[kind === 'none' ? 'in_planning' : 'scheduled'], zoneId, warehouse.id, `${refPrefix}${key}-${++seq}`,
                 warehouse.lat - (index + 1) * 0.01, warehouse.lon, route_batch_id, index + 1,
                 localInstant(shiftDate, '08:00'), localInstant(shiftDate, '18:00'), notifiedAt, firmedAt],
            );
            id[key] = dispatch_id;
            await dataSource.query(
                `INSERT INTO dispatch_packages (dispatch_id, external_package_id, length_cm, width_cm, height_cm, gross_weight_kg) VALUES ($1, $2, 20, 20, 20, 10)`,
                [dispatch_id, `${refPrefix}PKG-${dispatch_id}`],
            );
        }
        return route_batch_id as number;
    };

    const batchRow = async (batchId: number) =>
        (await dataSource.query(`SELECT status, version, vehicle_id, driver_id FROM route_batches WHERE route_batch_id = $1`, [batchId]))[0];
    const dispatchRow = async (key: Key) =>
        (await dataSource.query(`SELECT s.name AS status, d.route_batch_id, d.version FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id) WHERE d.dispatch_id = $1`, [id[key]]))[0];
    const manifestsOf = async (batchId: number) => await dataSource.query(
        `SELECT m.manifest_version, m.kind, m.reason,
                COALESCE(array_agg(s.dispatch_id ORDER BY s.dispatch_id) FILTER (WHERE s.dispatch_id IS NOT NULL), '{}') AS dispatch_ids,
                COALESCE(array_agg(s.stop_state ORDER BY s.dispatch_id) FILTER (WHERE s.dispatch_id IS NOT NULL), '{}') AS states
           FROM route_manifests m LEFT JOIN route_manifest_stops s USING (route_manifest_id)
          WHERE m.route_batch_id = $1 GROUP BY m.route_manifest_id ORDER BY m.manifest_version`,
        [batchId],
    );
    const ids = (...keys: Key[]) => keys.map((key) => id[key]).sort((a, b) => a - b);

    const approveFinal = async (batchId: number) => {
        const current = await batchRow(batchId);
        const dispatches = await dataSource.query(`SELECT dispatch_id AS id, version FROM dispatches WHERE route_batch_id = $1 ORDER BY sequence_order`, [batchId]);
        return await post(`/route-batches/${batchId}/approve-final`, {
            version: current.version,
            dispatches: dispatches.map((d: { id: number; version: number }) => ({ dispatchId: d.id, version: d.version })),
        });
    };
    const acceptAndStart = async (batchId: number, token: string) => {
        const accepted = await post(`/route-batches/${batchId}/accept`, { eventId: uuidv7() }, token);
        if (accepted.status !== 200 && accepted.status !== 201) return { accepted, started: null };
        const started = await post(`/route-batches/${batchId}/start`, { eventId: uuidv7() }, token);
        return { accepted, started };
    };
    const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    /** Reprogramación por el endpoint real, al primer slot de entrega configurado del día siguiente al de ruta. */
    const reschedule = async (key: Key) => {
        const settings = app.get(SettingsService);
        const [slot] = buildTimeSlots(
            { start: await settings.getString('morning_window_start', '09:00'), end: await settings.getString('morning_window_end', '13:00') },
            { start: await settings.getString('afternoon_window_start', '14:00'), end: await settings.getString('afternoon_window_end', '18:00') },
            await settings.getNumber('slot_duration_minutes', 120),
        );
        return await post(`/dispatches/${id[key]}/reschedule`, {
            reasonCode,
            windowStart: localInstant(addDays(shiftDate, 1), hhmm(slot.startMinute)).toISOString(),
            windowEnd: localInstant(addDays(shiftDate, 1), hhmm(slot.endMinute)).toISOString(),
        });
    };

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
        await makeUser('coordinator', 'coordinator', roles, passwordHash);
        await makeUser('supervisor', 'supervisor', roles, passwordHash);
        const driverA = await makeUser('driverA', 'driver', roles, passwordHash);
        const driverB = await makeUser('driverB', 'driver', roles, passwordHash);
        const driverC = await makeUser('driverC', 'driver', roles, passwordHash);
        for (const key of Object.keys(tokens) as (keyof typeof tokens)[]) tokens[key] = await login(key);

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
        const today = localDate(new Date());
        shiftDate = nextOperatingDay(today, loaded.values!.calendar);
        // El corte programado solo corre el día operativo anterior al día de ruta: en un fin de semana se toma ese día.
        const cutoffDay = previousOperatingDay(shiftDate, loaded.values!.calendar);
        cutoffAt = cutoffDay === today ? new Date() : localInstant(cutoffDay, '18:00');

        for (const n of [1, 2, 3] as const) {
            const [{ delivery_zone_id }] = await dataSource.query(
                `INSERT INTO delivery_zones (code, name, estimated_time_min) VALUES ($1, $2, 30) RETURNING delivery_zone_id`,
                [`RP${n}${run}`.slice(0, 20), `Zona e2e replan ${n} ${run}`],
            );
            zone[n] = delivery_zone_id;
            scope.zoneIds.push(delivery_zone_id);
        }
        const [{ vehicle_status_id }] = await dataSource.query(`SELECT vehicle_status_id FROM vehicle_statuses WHERE name = 'active'`);
        const vehicles: number[] = [];
        for (const tag of ['1', '2', '3', '4']) vehicles.push(await makeVehicle(vehicle_status_id, tag));
        const [{ reschedule_reason_id }] = await dataSource.query(
            `INSERT INTO reschedule_reasons (code, name, category, active) VALUES ($1, $2, 'operations', TRUE) RETURNING reschedule_reason_id`,
            [reasonCode, `Replan e2e ${run}`],
        );
        reasonId = reschedule_reason_id;

        // Una zona por ruta: cada lote es su propio grupo del corte y la reoptimización no los fusiona.
        batch.A = await makeBatch(zone[1], vehicles[0], driverA, ['a1', 'a2', 'a3', 'a4', 'a5', 'a7', 'a8']);
        batch.B = await makeBatch(zone[2], vehicles[1], driverB, ['b1', 'b2']);
        batch.C = await makeBatch(zone[3], vehicles[2], driverC, ['c1', 'c2']);
    });

    afterAll(async () => {
        if (!dataSource) return;
        for (const [key, value] of Object.entries(originalSettings)) {
            await dataSource.query(`UPDATE settings SET setting_value = $1 WHERE setting_key = $2`, [value, key]);
        }
        const batchIds: number[] = scope.zoneIds.length
            ? (await dataSource.query(`SELECT route_batch_id AS id FROM route_batches WHERE delivery_zone_id = ANY($1::int[])`, [scope.zoneIds])).map((r: { id: number }) => r.id)
            : [];
        const userNames = [`${userPrefix}%_${run}`];
        await withEventPurge(dataSource, { dispatchRefs: [`${refPrefix}%`], routeBatchIds: batchIds, userNames }, async (manager) => {
            // withEventPurge borra solo las cabeceras que vació; las de esta corrida van por su occurrence y por su ID.
            await manager.query(
                `DELETE FROM planning_cutoff_dispatches WHERE planning_cutoff_id IN (SELECT planning_cutoff_id FROM planning_cutoffs WHERE occurrence = $1 OR planning_cutoff_id = ANY($2::int[]))`,
                [occurrence, [...scope.cutoffIds]],
            );
            await manager.query(`DELETE FROM planning_cutoffs WHERE occurrence = $1 OR planning_cutoff_id = ANY($2::int[])`, [occurrence, [...scope.cutoffIds]]);
            await manager.query(`DELETE FROM outbound_messages WHERE payload #>> '{data,salesOrderId}' LIKE $1`, [`${refPrefix}%`]);
            // La auditoría administrativa de lo que hicieron los usuarios de esta corrida (cancelar, reprogramar, aprobar...).
            await manager.query(`DELETE FROM admin_audit_events WHERE actor_user_id IN (SELECT user_id FROM users WHERE username LIKE $1)`, userNames);
        });
        await dataSource.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${refPrefix}%`]);
        if (batchIds.length) await dataSource.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
        if (scope.vehicleIds.size) await dataSource.query(`DELETE FROM vehicles WHERE vehicle_id = ANY($1::int[])`, [[...scope.vehicleIds]]);
        if (scope.zoneIds.length) await dataSource.query(`DELETE FROM delivery_zones WHERE delivery_zone_id = ANY($1::int[])`, [scope.zoneIds]);
        if (reasonId) await dataSource.query(`DELETE FROM reschedule_reasons WHERE reschedule_reason_id = $1`, [reasonId]);
        await dataSource.query(
            `DELETE FROM audit_logs WHERE created_at >= $1 AND (action = $2 OR (action = $3 AND detail LIKE '%"trigger":"manual"%'))`,
            [startedAt, PLAN_ALERT_ACTION, SCHEDULED_TASK_RUN_ACTION],
        );
        await dataSource.query(`DELETE FROM users WHERE username LIKE $1`, userNames);
        await app?.close();
    });

    describe('the scheduled cutoff, run for real', () => {
        it('freezes the universe before reorganizing: a remnant batch for the open window, the one without promise back to pending', async () => {
            const summary = await app.get(RouteCutoffService).run({ trigger: 'schedule', occurrence, startedAt: cutoffAt });

            expect(summary.status).toBe('executed');
            expect(summary.shiftDate).toBe(shiftDate);
            expect(summary.pendingFinalReviewBatchIds.sort()).toEqual([batch.A, batch.B, batch.C].sort());
            expect(summary.releasedDispatchIds).toEqual([id.a5]);
            expect(summary.remnantBatchIds).toHaveLength(1);
            batch.R = summary.remnantBatchIds[0];
            scope.batchIds.add(batch.R);

            const [header] = await dataSource.query(`SELECT planning_cutoff_id AS id, trigger_type, shift_date::text AS shift_date FROM planning_cutoffs WHERE occurrence = $1`, [occurrence]);
            expect(header).toMatchObject({ trigger_type: 'scheduled', shift_date: shiftDate });
            scheduledId = header.id;
            scope.cutoffIds.add(scheduledId);

            const items = await dataSource.query(
                `SELECT dispatch_id, universe_status, exclusion_code, route_batch_id FROM planning_cutoff_dispatches WHERE planning_cutoff_id = $1 AND dispatch_id = ANY($2::int[])`,
                [scheduledId, ids(...KEYS)],
            );
            const byId = new Map(items.map((item: { dispatch_id: number }) => [item.dispatch_id, item]));
            for (const key of KEYS) {
                expect(byId.get(id[key]), key).toMatchObject({ universe_status: CASES[key].universe, exclusion_code: CASES[key].code });
            }
            // The snapshot keeps the batch the dispatch had at the cutoff; today it is elsewhere.
            expect((byId.get(id.a4) as { route_batch_id: number }).route_batch_id).toBe(batch.A);
            expect((await dispatchRow('a4')).route_batch_id).toBe(batch.R);
            expect(await dispatchRow('a5')).toMatchObject({ status: 'pending', route_batch_id: null });
        });

        it('gives the coverage of the table per zone, the same by cutoffId and by date', async () => {
            for (const n of [1, 2, 3] as const) {
                const byId = await coverage(`cutoffId=${scheduledId}&zoneId=${zone[n]}`);
                const byDate = await coverage(`date=${shiftDate}&zoneId=${zone[n]}`);
                expect(byId.status).toBe(200);
                expect(byId.body.coverage).toMatchObject({ ...expectedCoverage(n), confirmed: 0, pending: expectedCoverage(n).eligible, coveragePct: 0 });
                expect(byDate.body).toEqual(byId.body);
            }
            const z1 = (await coverage(`cutoffId=${scheduledId}&zoneId=${zone[1]}`)).body;
            expect(z1.excluded.data.map((item: { dispatchId: number; code: string; routeBatchId: number }) => [item.dispatchId, item.code, item.routeBatchId]).sort()).toEqual(
                [[id.a4, 'cutoff_window_open', batch.A], [id.a5, 'cutoff_no_promise', batch.A]].sort(),
            );
        });
    });

    describe('replanning after the cutoff', () => {
        let before: Record<number, unknown> = {};

        it('takes a dispatch out of its batch by cancelling it through the endpoint', async () => {
            for (const n of [1, 2, 3] as const) before[n] = (await coverage(`cutoffId=${scheduledId}&zoneId=${zone[n]}`)).body;
            const versionBefore = (await batchRow(batch.A)).version;

            const response = await post(`/dispatches/${id.a3}/cancel`, { reason: 'Cliente desiste antes de la ruta' });

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ dispatchId: id.a3, status: 'cancelled', previousStatus: 'scheduled', routeBatchId: null });
            expect(await dispatchRow('a3')).toMatchObject({ status: 'cancelled', route_batch_id: null });
            expect((await batchRow(batch.A)).version).toBe(versionBefore + 1);
        });

        it('firms the promise the customer confirms, and the manual cutoff plans its remnant batch with its own snapshot', async () => {
            const firmed = await app.get(PromiseFirmingService).firm(id.a4, { reason: 'customer_confirmed' });
            expect(firmed.outcome).toBe('firmed');

            const response = await post('/planning/cutoff');
            expect(response.status).toBe(200);

            const [manual] = await dataSource.query(
                `SELECT c.planning_cutoff_id AS id, c.trigger_type, c.occurrence, i.universe_status, i.route_batch_id
                   FROM planning_cutoffs c JOIN planning_cutoff_dispatches i USING (planning_cutoff_id)
                  WHERE i.dispatch_id = $1 AND c.planning_cutoff_id <> $2`,
                [id.a4, scheduledId],
            );
            expect(manual).toMatchObject({ trigger_type: 'manual', occurrence: null, universe_status: 'eligible', route_batch_id: batch.R });
            manualId = manual.id;
            scope.cutoffIds.add(manualId);
            // Only the provisional batches enter a cutoff: the batches already reviewed are not in the manual universe.
            const manualMine = await dataSource.query(`SELECT dispatch_id FROM planning_cutoff_dispatches WHERE planning_cutoff_id = $1 AND dispatch_id = ANY($2::int[])`, [manualId, ids(...KEYS)]);
            expect(manualMine.map((row: { dispatch_id: number }) => row.dispatch_id)).toEqual([id.a4]);
            expect((await batchRow(batch.R)).status).not.toBe('provisional');
        });

        it('repeating the scheduled occurrence keeps the first snapshot and does nothing', async () => {
            const again = await app.get(RouteCutoffService).run({ trigger: 'schedule', occurrence, startedAt: new Date(cutoffAt.getTime() + 60_000) });
            expect(again.status).toBe('nothing_to_process');
            expect(await dataSource.query(`SELECT 1 FROM planning_cutoffs WHERE occurrence = $1`, [occurrence])).toHaveLength(1);
        });

        it('keeps the official cutoff and its denominator; the manual one is listed apart', async () => {
            const list = await get(`/planning/cutoffs?date=${shiftDate}`);
            expect(list.body.data.find((c: { id: number }) => c.id === scheduledId)).toMatchObject({ official: true, triggerType: 'scheduled' });
            expect(list.body.data.find((c: { id: number }) => c.id === manualId)).toMatchObject({ official: false, triggerType: 'manual' });
            for (const n of [1, 2, 3] as const) {
                const byId = await coverage(`cutoffId=${scheduledId}&zoneId=${zone[n]}`);
                expect(byId.body).toEqual(before[n]);
                expect((await coverage(`date=${shiftDate}&zoneId=${zone[n]}`)).body).toEqual(byId.body);
            }
            const manualCoverage = await coverage(`cutoffId=${manualId}&zoneId=${zone[1]}`);
            expect(manualCoverage.body.cutoff).toMatchObject({ id: manualId, official: false });
            expect(manualCoverage.body.coverage).toMatchObject({ eligible: 1, confirmed: 0, coveragePct: 0 });
        });

        it('counts the second approval in the numerator and never the stop that left the batch', async () => {
            for (const key of ['A', 'B', 'C'] as const) expect((await approveFinal(batch[key])).status, key).toBe(200);

            for (const n of [1, 2, 3] as const) {
                const byId = await coverage(`cutoffId=${scheduledId}&zoneId=${zone[n]}`);
                expect(byId.body.coverage).toEqual({ ...expectedCoverage(n), confirmedOutsideUniverse: 0 });
                expect((await coverage(`date=${shiftDate}&zoneId=${zone[n]}`)).body).toEqual(byId.body);
            }
            // Zona 1 a mano: 5 elegibles (a1, a2, a3, a7, a8), 4 confirmadas (a3 se canceló antes de la aprobación) = 80 %.
            expect(expectedCoverage(1)).toEqual({ eligible: 5, confirmed: 4, pending: 1, coveragePct: 80 });
        });
    });

    describe('before the route leaves', () => {
        it('a stop rescheduled through the endpoint leaves the confirmed route', async () => {
            const response = await reschedule('a7');
            expect(response.status).toBe(200);
            expect(await dispatchRow('a7')).toMatchObject({ status: 'rescheduled', route_batch_id: null });
        });

        it('starts A and B for real and freezes their started manifests without the stop that left', async () => {
            const a = await acceptAndStart(batch.A, tokens.driverA);
            const b = await acceptAndStart(batch.B, tokens.driverB);
            expect(a.started?.status).toBe(200);
            expect(b.started?.status).toBe(200);

            const manifestsA = await manifestsOf(batch.A);
            expect(manifestsA.map((m: { manifest_version: number; kind: string }) => [m.manifest_version, m.kind])).toEqual([[1, 'confirmed'], [2, 'started']]);
            expect(manifestsA[0].dispatch_ids).toEqual(ids('a1', 'a2', 'a7', 'a8'));
            expect(manifestsA[1].dispatch_ids).toEqual(ids('a1', 'a2', 'a8'));
            expect(manifestsA[1].states).toEqual(['departing', 'departing', 'departing']);
        });

        it('a confirmed stop cancelled through the endpoint leaves its batch and the route starts without it', async () => {
            const cancelled = await post(`/dispatches/${id.c2}/cancel`, { reason: 'Cliente desiste con la ruta confirmada' });
            expect(cancelled.status).toBe(200);
            // The route has not left yet: the cancelled stop goes out of the batch, like a planned one.
            expect(cancelled.body).toMatchObject({ previousStatus: 'assigned', status: 'cancelled', routeBatchId: null });
            expect(await dispatchRow('c2')).toMatchObject({ status: 'cancelled', route_batch_id: null });

            const c = await acceptAndStart(batch.C, tokens.driverC);
            expect(c.started?.status).toBe(200);
            expect(c.started?.body.dispatchIds).toEqual([id.c1]);
            const manifestsC = await manifestsOf(batch.C);
            expect(manifestsC.map((m: { manifest_version: number; kind: string }) => [m.manifest_version, m.kind])).toEqual([[1, 'confirmed'], [2, 'started']]);
            expect(manifestsC[0].dispatch_ids).toEqual(ids('c1', 'c2'));
            expect(manifestsC[1].dispatch_ids).toEqual(ids('c1'));
        });
    });

    describe('during the route', () => {
        it('a stop not delivered and rescheduled by the coordinator writes a revised manifest and counts as unsuccessful', async () => {
            expect((await driverStatus(tokens.driverA, id.a2, 'in_transit')).status).toBe(200);
            expect((await driverStatus(tokens.driverA, id.a2, 'not_delivered')).status).toBe(200);
            const response = await reschedule('a2');
            expect(response.status).toBe(200);

            const manifestsA = await manifestsOf(batch.A);
            expect(manifestsA.map((m: { kind: string }) => m.kind)).toEqual(['confirmed', 'started', 'revised']);
            expect(manifestsA[2].dispatch_ids).toEqual(ids('a1', 'a8'));
            expect(manifestsA[2].reason).toBeTruthy();

            expect((await driverStatus(tokens.driverB, id.b2, 'in_transit')).status).toBe(200);
            expect((await driverStatus(tokens.driverB, id.b2, 'not_delivered')).status).toBe(200);
        });

        it('a stop reassigned between two started routes writes one revised manifest per route', async () => {
            const [origin, target] = [await batchRow(batch.A), await batchRow(batch.B)];
            const response = await post(`/route-batches/${batch.A}/reassign`, {
                dispatchIds: [id.a1], targetBatchId: batch.B, reasonCode, version: origin.version, targetVersion: target.version,
            });
            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ fromBatchId: batch.A, toBatchId: batch.B, fromBatchClosed: false });

            const manifestsA = await manifestsOf(batch.A);
            const manifestsB = await manifestsOf(batch.B);
            expect(manifestsA.map((m: { kind: string }) => m.kind)).toEqual(['confirmed', 'started', 'revised', 'revised']);
            expect(manifestsB.map((m: { kind: string }) => m.kind)).toEqual(['confirmed', 'started', 'revised']);
            expect(manifestsA[3]).toMatchObject({ reason: reasonCode, dispatch_ids: ids('a8') });
            expect(manifestsB[2]).toMatchObject({ reason: reasonCode, dispatch_ids: ids('a1', 'b1', 'b2') });
        });

        it('the destination route delivers the reassigned stop', async () => {
            expect((await driverStatus(tokens.driverB, id.a1, 'in_transit')).status).toBe(200);
            const evidenceId = uuidv7();
            await dataSource.query(
                `INSERT INTO delivery_evidences (delivery_evidence_id, dispatch_id, type, file_url, captured_at, receiver_name, receiver_document)
                 VALUES ($1, $2, 'signature', 'e2e://signature.png', NOW(), 'Receptor E2E', '1234567')`,
                [evidenceId, id.a1],
            );
            expect((await driverStatus(tokens.driverB, id.a1, 'delivered', { evidenceId, type: 'signature' })).status).toBe(200);
            expect(await dispatchRow('a1')).toMatchObject({ status: 'delivered', route_batch_id: batch.B });
        });
    });

    describe('route completion over the frozen baseline', () => {
        it('gives each route the counts of the table, each stop in one category', async () => {
            for (const [route, n] of [['A', 1], ['B', 2], ['C', 3]] as const) {
                const response = await completion(`zoneId=${zone[n]}`);
                expect(response.status).toBe(200);
                const expected = expectedRoute(route);
                expect(response.body.data).toHaveLength(1);
                const [data] = response.body.data;
                expect(data).toMatchObject({ routeBatchId: batch[route], manifestVersion: 2, departed: expected.departed, finalized: expected.finalized, finalizedPct: expected.finalizedPct });
                expect(data.counts).toEqual(expected.counts);
                const outcomes = Object.fromEntries(data.stops.map((stop: { dispatchId: number; outcome: string }) => [stop.dispatchId, stop.outcome]));
                expect(outcomes).toEqual(Object.fromEntries(expected.keys.map((key) => [id[key], CASES[key].outcome])));
            }
            // A mano: A = a1 entregada (en B), a2 no exitosa, a8 pendiente, a7 quitada antes de salir → 2 de 3 = 66,67 %.
            expect(expectedRoute('A')).toMatchObject({ departed: 3, finalized: 2, finalizedPct: 66.67 });
            expect(expectedRoute('B')).toMatchObject({ departed: 2, finalized: 1, finalizedPct: 50 });
            // C = c1 pendiente, c2 cancelada antes de salir (no cuenta como salida) → 0 de 1.
            expect(expectedRoute('C')).toMatchObject({ departed: 1, finalized: 0, finalizedPct: 0, counts: expect.objectContaining({ cancelledBeforeStart: 1 }) });
        });

        it('counts the reassigned stop only in the route it left, with its current status (current behaviour)', async () => {
            const b = (await completion(`zoneId=${zone[2]}`)).body.data[0];
            expect(b.stops.map((stop: { dispatchId: number }) => stop.dispatchId)).not.toContain(id.a1);
            const a = (await completion(`zoneId=${zone[1]}`)).body.data[0];
            expect(a.stops.find((stop: { dispatchId: number }) => stop.dispatchId === id.a1)).toMatchObject({ outcome: 'delivered', currentStatus: 'delivered' });
        });

        it('keeps the baseline after the revisions: the started manifest, not the last revised one', async () => {
            const a = (await completion(`zoneId=${zone[1]}`)).body.data[0];
            expect(a.manifestVersion).toBe(2);
            expect(a.stops).toHaveLength(4);
        });

        it('weights the summary by stops, never by averaging the routes', async () => {
            const response = await completion('');
            expect(response.body.data.map((route: { routeBatchId: number }) => route.routeBatchId)).toEqual(expect.arrayContaining([batch.A, batch.B]));
            const sum = response.body.data.reduce(
                (acc: { departed: number; finalized: number }, route: { departed: number; finalized: number }) => ({ departed: acc.departed + route.departed, finalized: acc.finalized + route.finalized }),
                { departed: 0, finalized: 0 },
            );
            expect(response.body.summary).toMatchObject({ departed: sum.departed, finalized: sum.finalized, finalizedPct: Math.round((sum.finalized / sum.departed) * 10000) / 100 });
            // Con solo A y B: 3 de 5 = 60 %, no el promedio (66,67 + 50) / 2 = 58,33 %.
            const mine = response.body.data.filter((route: { routeBatchId: number }) => route.routeBatchId === batch.A || route.routeBatchId === batch.B);
            const mineFinalized = mine.reduce((acc: number, route: { finalized: number }) => acc + route.finalized, 0);
            const mineDeparted = mine.reduce((acc: number, route: { departed: number }) => acc + route.departed, 0);
            expect(Math.round((mineFinalized / mineDeparted) * 10000) / 100).toBe(60);
        });

        it('counts the stop cancelled before the start apart, never as a departed or unsuccessful stop', async () => {
            const c = (await completion(`zoneId=${zone[3]}`)).body.data[0];
            expect(c.stops.find((stop: { dispatchId: number }) => stop.dispatchId === id.c2)).toMatchObject({ outcome: 'cancelled_before_start', currentStatus: 'cancelled' });
            expect(c).toMatchObject({ departed: 1, counts: expect.objectContaining({ unsuccessful: 0, cancelledBeforeStart: 1 }) });
        });
    });

    describe('the cohort does not move with the execution', () => {
        it('gives the same coverage after the reschedules, the reassignment and the deliveries', async () => {
            for (const n of [1, 2, 3] as const) {
                const byId = await coverage(`cutoffId=${scheduledId}&zoneId=${zone[n]}`);
                expect(byId.body.coverage).toEqual({ ...expectedCoverage(n), confirmedOutsideUniverse: 0 });
                expect(byId.body.excluded.total).toBe(ofZone(n).filter((key) => CASES[key].universe === 'excluded').length);
                expect((await coverage(`date=${shiftDate}&zoneId=${zone[n]}`)).body).toEqual(byId.body);
            }
        });
    });

    describe('what the dashboard must not show', () => {
        it('never answers a duration, an ETA or an end time: there is no planned time to compare with', async () => {
            const bodies = [
                (await completion('')).body,
                (await coverage(`cutoffId=${scheduledId}`)).body,
                (await get(`/planning/cutoffs?date=${shiftDate}`)).body,
            ];
            const forbidden = /duration|^eta|Eta[A-Z]?|minutes|elapsed|endedAt|finishedAt|closedAt|plannedStart|plannedEnd|actualStart|actualEnd/;
            for (const body of bodies) expect([...allKeys(body)].filter((key) => forbidden.test(key))).toEqual([]);
            // The route only knows when it left (the started manifest), never when it is planned to end.
            const a = (await completion(`zoneId=${zone[1]}`)).body.data[0];
            expect(Number.isNaN(Date.parse(a.startedAt))).toBe(false);
        });

        it('does not leak customer data, tokens or evidence in the completion or the coverage', async () => {
            const bodies = [(await completion(`zoneId=${zone[1]}`)).body, (await completion(`zoneId=${zone[2]}`)).body, (await coverage(`cutoffId=${scheduledId}&zoneId=${zone[1]}`)).body];
            for (const body of bodies) {
                const keys = [...allKeys(body)];
                expect(keys.filter((key) => /address|customer|phone|email|token|trackingCode|evidence|signature|receiver|latitude|longitude/i.test(key))).toEqual([]);
                const text = JSON.stringify(body);
                expect(text).not.toContain('Calle Privada');
                expect(text).not.toContain('Receptor E2E');
                expect(text).not.toContain('e2e://');
            }
        });

        it('is closed to the driver and to a request without token', async () => {
            for (const path of [`/planning/route-completion?date=${shiftDate}`, `/planning/cutoffs/coverage?cutoffId=${scheduledId}`, `/planning/cutoffs?date=${shiftDate}`]) {
                expect((await get(path, tokens.driverA)).status).toBe(403);
                expect((await get(path, tokens.supervisor)).status).toBe(403);
                expect((await request(app.getHttpServer()).get(api(path))).status).toBe(401);
            }
        });
    });
});
