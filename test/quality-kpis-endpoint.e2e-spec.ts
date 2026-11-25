// ST-300.2 — GET /reports/quality (Dashboard 4 de ES-300) contra una base real: permisos, filtros combinados, cero/uno/muchos resultados,
// paginación y N/D. El cálculo en sí lo cubre test/quality-kpis.e2e-spec.ts (ST-300.1); acá se prueba el contrato del endpoint.
// Los datos viven en abril de 2020 y en zonas propias de la corrida: todas las consultas llevan `zoneId`, así que ningún otro dato las toca.
// Cifras esperadas, recalculadas a mano (zona MAIN):
//   intentos: A 1, B 2 (el primero termina en incidencia reportada DOS veces), C 1 = 4; con incidencia: 1 → 25.0
//   elegibles: A, B, C = 3; reprogramados (cambió la ventana): B = 1 → 33.3
//   entregados: A, B, C = 3; casos: A (decidido, 60 min) y B (abierto) = 2 → 66.7; mediana 60 con n = 1; abiertos 1
//   rating (solo supervisor y root): 5 y 3 → 4.0 con n = 2
// Ojo: la cobertura de intentos es GLOBAL (primer in_transit instrumentado de toda la base), no por zona. La suite siembra el suyo en 2020-04-02; un evento
// anterior que otra suite deje sin borrar haría fallar el caso «available: true» del primer test. No cubre root: su paso por el guard es el bypass genérico del RolesGuard.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

const win = (day: string): [string, string] => [`2020-04-${day}T18:00:00Z`, `2020-04-${day}T20:00:00Z`];
const at = (day: string, time: string) => `2020-04-${day}T${time}:00Z`;
const RANGE = { from: '2020-04-05', to: '2020-04-30' };

describe('GET /reports/quality (e2e, ST-300.2)', () => {
    let app: INestApplication;
    let db: DataSource;
    let prefix: string;
    const run = Date.now().toString(36).toUpperCase();
    const tag = 'e2e_q_';
    const ref = `ST3002-${run}`;
    const tokens: Record<string, string> = {};
    const zone = { MAIN: 0, OTHER: 0, EMPTY: 0 };
    const dispatchOf: Record<string, number> = {};
    const statusIds: Record<string, number> = {};
    const reasonIds: Record<string, number> = {};
    let deliveryTypeId = 0;
    let rescheduleReasonId = 0;
    let coordinatorUserId = 0;

    const http = () => request(app.getHttpServer());
    const api = (path: string) => `/${prefix}${path}`;
    const get = (query: Record<string, unknown>, role: string | null = 'supervisor') => {
        const req = http().get(api('/reports/quality')).query({ ...RANGE, zoneId: zone.MAIN, ...query });
        return role ? req.set('Authorization', `Bearer ${tokens[role]}`) : req;
    };

    const insertDispatch = async (key: string, status: string, day: string, zoneId: number) => {
        const [{ dispatch_id: id }] = await db.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, delivery_zone_id, source_order_ref, delivery_address, closed_at, scheduled_window_start, scheduled_window_end)
             VALUES ($1, $2, $3, $4, 'Dirección E2E ST-300.2', $5, $6, $7) RETURNING dispatch_id`,
            [deliveryTypeId, statusIds[status], zoneId, `${ref}-${key}`, at(day, '19:00'), win(day)[0], win(day)[1]],
        );
        dispatchOf[key] = id;
    };

    const event = (key: string, status: string, previous: string, createdAt: string, options: { clientEventId?: string; reason?: string } = {}) =>
        db.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, client_event_id, actor_type, reason, metadata, created_at)
             VALUES ($1, 'status_changed', $2, 'user', $3, $4::jsonb, $5)`,
            [dispatchOf[key], options.clientEventId ?? null, options.reason ?? null, JSON.stringify({ previousStatus: previous, status }), createdAt],
        );

    const incident = async (key: string, reason: string, createdAt: string) => {
        const id = randomUUID();
        await db.query(`INSERT INTO dispatch_incidents (dispatch_incident_id, dispatch_id, incident_reason_id) VALUES ($1, $2, $3)`, [id, dispatchOf[key], reasonIds[reason]]);
        await event(key, 'incident', 'in_transit', createdAt, { clientEventId: id, reason });
    };

    const complaintCase = (key: string, reasonCode: string, openedAt: string, decision?: { startedAt: string; decidedAt: string }) =>
        db.query(
            `INSERT INTO delivery_complaint_cases
                (message_id, source, crm_case_id, case_version, dispatch_id, reason_code, affected_items, opened_at, consumed_at, intake_status, acknowledged_at,
                 investigation_status, assigned_user_id, assigned_at, investigation_started_at, verdict, decision_reason, decided_by_user_id, decided_at)
             VALUES (gen_random_uuid(), 'crm', $1, 1, $2, $3, '[{"itemCode":"SKU-1","quantity":1}]'::jsonb, $4, $4, 'acknowledged', $4,
                     $5, $6, $7, $8, $9, $10, $11, $12)`,
            decision
                ? [`${ref}-${key}`, dispatchOf[key], reasonCode, openedAt, 'decided', coordinatorUserId, decision.startedAt, decision.startedAt, 'not_confirmed', 'Seeded reason.', coordinatorUserId, decision.decidedAt]
                : [`${ref}-${key}`, dispatchOf[key], reasonCode, openedAt, 'received', null, null, null, null, null, null, null],
        );

    const createUser = async (key: string, role: string) => {
        const username = `${tag}${key}_${run}`;
        const [{ user_id: id }] = await db.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change, active)
             VALUES ((SELECT role_id FROM roles WHERE name = $1), $2, $3, $4, FALSE, TRUE) RETURNING user_id`,
            [role, `Quality ${key} ${run}`, username, await hashPassword('E2eTest1234')],
        );
        if (key === 'coordinator') coordinatorUserId = id as number;
        const res = await http().post(api('/auth/login')).send({ username, password: 'E2eTest1234' });
        tokens[key] = res.body.accessToken as string;
    };

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        prefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(prefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        db = moduleRef.get(DataSource);

        for (const [key, role] of [['coordinator', 'coordinator'], ['supervisor', 'supervisor'], ['admin', 'admin'], ['driver', 'driver']] as const) await createUser(key, role);
        for (const key of ['MAIN', 'OTHER', 'EMPTY'] as const) {
            const [{ delivery_zone_id: id }] = await db.query(
                `INSERT INTO delivery_zones (code, name, estimated_time_min) VALUES ($1, $2, 60) RETURNING delivery_zone_id`, [`Z3002${run}${key}`, `E2E3002 ${run} ${key}`]);
            zone[key] = id;
        }
        for (const row of await db.query(`SELECT dispatch_status_id, name FROM dispatch_statuses`)) statusIds[row.name] = row.dispatch_status_id;
        for (const row of await db.query(`SELECT incident_reason_id, code FROM incident_reasons`)) reasonIds[row.code] = row.incident_reason_id;
        [{ dispatch_type_id: deliveryTypeId }] = await db.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);
        [{ reschedule_reason_id: rescheduleReasonId }] = await db.query(`SELECT reschedule_reason_id FROM reschedule_reasons WHERE code = 'RES-CLI-SELF'`);

        // Other zone, before the range: its trip (April 2) is the first one the backend wrote, so the instrumented period starts there.
        await insertDispatch('PRE', 'delivered', '02', zone.OTHER);
        await event('PRE', 'in_transit', 'out_for_delivery', at('02', '17:00'));
        await event('PRE', 'delivered', 'in_transit', at('02', '19:00'));

        // A: one attempt; a decided case of 60 minutes (DAMAGED); rating 5.
        await insertDispatch('A', 'delivered', '10', zone.MAIN);
        await event('A', 'in_transit', 'out_for_delivery', at('10', '17:00'));
        await event('A', 'delivered', 'in_transit', at('10', '19:00'));
        await complaintCase('A', 'DAMAGED', at('11', '09:00'), { startedAt: at('11', '10:00'), decidedAt: at('11', '11:00') });
        await db.query(`INSERT INTO dispatch_ratings (dispatch_id, score) VALUES ($1, 5)`, [dispatchOf.A]);

        // B: attempt 1 ends in an incident reported twice, attempt 2 delivered; the window changed once; an open case (LATE).
        await insertDispatch('B', 'delivered', '12', zone.MAIN);
        await event('B', 'in_transit', 'out_for_delivery', at('12', '17:00'));
        await incident('B', 'INC-CUST-ABSENT', at('12', '17:30'));
        await incident('B', 'INC-CUST-ABSENT', at('12', '17:31'));
        await event('B', 'in_transit', 'incident', at('12', '18:00'));
        await event('B', 'delivered', 'in_transit', at('12', '19:00'));
        await db.query(
            `INSERT INTO dispatch_reschedules (dispatch_id, reschedule_reason_id, rescheduled_by_type, previous_window_start, previous_window_end, new_window_start, new_window_end)
             VALUES ($1, $2, 'system', $3, $4, $5, $6)`,
            [dispatchOf.B, rescheduleReasonId, win('11')[0], win('11')[1], win('12')[0], win('12')[1]],
        );
        await complaintCase('B', 'LATE', at('13', '09:00'));

        // C: one attempt, rating 3, no case, never rescheduled.
        await insertDispatch('C', 'delivered', '14', zone.MAIN);
        await event('C', 'in_transit', 'out_for_delivery', at('14', '17:00'));
        await event('C', 'delivered', 'in_transit', at('14', '19:00'));
        await db.query(`INSERT INTO dispatch_ratings (dispatch_id, score) VALUES ($1, 3)`, [dispatchOf.C]);
    });

    afterAll(async () => {
        if (!db) return;
        try {
            await withEventPurge(db, { dispatchRefs: [`${ref}%`], routeBatchIds: [], userNames: [`${tag}%_${run}`] }, async (manager) => {
                await manager.query(`DELETE FROM delivery_complaint_cases WHERE dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE source_order_ref LIKE $1)`, [`${ref}%`]);
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${ref}%`]);
                await manager.query(`DELETE FROM delivery_zones WHERE code LIKE $1`, [`Z3002${run}%`]);
                await manager.query(`DELETE FROM users WHERE username LIKE $1`, [`${tag}%_${run}`]);
            });
        } finally {
            await app?.close();
        }
    });

    describe('permissions', () => {
        it('401 without a token', async () => {
            expect((await get({}, null)).status).toBe(401);
        });

        it('403 for the admin and the driver; the coordinator, the supervisor get the data', async () => {
            expect((await get({}, 'admin')).status).toBe(403);
            expect((await get({}, 'driver')).status).toBe(403);
            expect((await get({}, 'coordinator')).status).toBe(200);
            expect((await get({}, 'supervisor')).status).toBe(200);
        });

        it('a forbidden role gets no figure at all', async () => {
            const res = await get({}, 'driver');
            expect(res.body.kpis).toBeUndefined();
            expect(res.body.tables).toBeUndefined();
        });
    });

    describe('many results (the reference case, recomputed by hand)', () => {
        it('the supervisor reads every indicator, with numerator, denominator and n', async () => {
            const res = await get({});
            expect(res.status).toBe(200);
            const { incidentRate, rescheduleRate, complaintRate, investigationTime, ratingAverage, responseRate } = res.body.kpis;
            expect(incidentRate).toMatchObject({ numerator: 1, denominator: 4, n: 4, value: 25, available: true, reason: null });
            expect(rescheduleRate).toMatchObject({ numerator: 1, denominator: 3, n: 3, value: 33.3 });
            expect(complaintRate).toMatchObject({ numerator: 2, denominator: 3, n: 3, value: 66.7 });
            expect(investigationTime).toMatchObject({ value: 60, n: 1, available: true });
            expect(ratingAverage).toMatchObject({ value: 4, n: 2, available: true });
            expect(responseRate).toMatchObject({ available: false, reason: 'response_opportunity_not_recorded', value: null });
            expect(res.body.details.complaints.open).toMatchObject({ count: 1 });
            expect(res.body.details.attempts).toMatchObject({ attemptCount: 4, attemptsWithIncidentCount: 1, incidentEventCount: 2 });
            expect(res.body.period).toEqual({ ...RANGE, timeZone: 'America/La_Paz' });
            expect(res.body.filters).toEqual({ zoneId: zone.MAIN, status: null, incidentReasonId: null, reasonCode: null, rescheduled: null });
            expect(res.body.sources).toEqual(expect.arrayContaining(['dispatch_events', 'delivery_complaint_cases', 'dispatch_ratings']));
        });

        it('the coordinator reads the same indicators but the rating is N/D, and it is not among the sources', async () => {
            const res = await get({}, 'coordinator');
            expect(res.body.kpis.incidentRate).toMatchObject({ numerator: 1, denominator: 4, value: 25 });
            expect(res.body.kpis.ratingAverage).toMatchObject({ available: false, value: null, n: 0, reason: 'rating_not_authorized' });
            expect(res.body.sources).not.toContain('dispatch_ratings');
        });

        it('cases and dispatches come apart, without personal data, findings or evidence', async () => {
            const res = await get({ order: 'asc' });
            const { cases, dispatches } = res.body.tables;
            expect(cases.meta).toEqual({ page: 1, limit: 10, pages: 1, total: 2 });
            expect(dispatches.meta).toEqual({ page: 1, limit: 10, pages: 1, total: 3 });
            expect(cases.data.map((c: { dispatchId: number }) => c.dispatchId)).toEqual([dispatchOf.A, dispatchOf.B]);
            expect(Object.keys(cases.data[0]).sort()).toEqual([
                'ageMinutes', 'caseId', 'decidedAt', 'dispatchId', 'investigationStartedAt', 'investigationStatus', 'open', 'openedAt', 'reasonCode',
            ]);
            expect(Object.keys(dispatches.data[0]).sort()).toEqual([
                'attemptCount', 'attemptsWithIncidentCount', 'dispatchId', 'incidentEventCount', 'reconstructable', 'rescheduled', 'status',
            ]);
            const text = JSON.stringify(res.body);
            for (const forbidden of ['findings', 'Dirección', 'affectedItems', 'evidence', 'trackingCode', 'http']) expect(text).not.toContain(forbidden);
            const b = dispatches.data.find((d: { dispatchId: number }) => d.dispatchId === dispatchOf.B);
            expect(b).toMatchObject({ attemptCount: 2, attemptsWithIncidentCount: 1, incidentEventCount: 2, rescheduled: true, reconstructable: true });
        });
    });

    describe('pagination', () => {
        it('pages the dispatches by id in both orders, and a page past the end is empty', async () => {
            const ids = [dispatchOf.A, dispatchOf.B, dispatchOf.C].sort((a, b) => a - b);
            const first = await get({ order: 'asc', limit: 2, page: 1 });
            expect(first.body.tables.dispatches.meta).toEqual({ page: 1, limit: 2, pages: 2, total: 3 });
            expect(first.body.tables.dispatches.data.map((d: { dispatchId: number }) => d.dispatchId)).toEqual(ids.slice(0, 2));
            const second = await get({ order: 'asc', limit: 2, page: 2 });
            expect(second.body.tables.dispatches.data.map((d: { dispatchId: number }) => d.dispatchId)).toEqual(ids.slice(2));
            const desc = await get({ order: 'desc', limit: 3 });
            expect(desc.body.tables.dispatches.data.map((d: { dispatchId: number }) => d.dispatchId)).toEqual([...ids].reverse());
            const past = await get({ limit: 2, page: 9 });
            expect(past.status).toBe(200);
            expect(past.body.tables.dispatches.data).toEqual([]);
            expect(past.body.tables.dispatches.meta.total).toBe(3);
        });

        it('the indicators cover the whole cohort, not just the page', async () => {
            const res = await get({ limit: 1 });
            expect(res.body.kpis.complaintRate).toMatchObject({ numerator: 2, denominator: 3 });
            expect(res.body.tables.cases.data).toHaveLength(1);
        });
    });

    describe('combined filters', () => {
        it('reasonCode narrows the cases, not the delivered dispatches', async () => {
            const res = await get({ reasonCode: 'damaged' });
            expect(res.body.kpis.complaintRate).toMatchObject({ numerator: 1, denominator: 3, value: 33.3 });
            expect(res.body.tables.cases.meta.total).toBe(1);
            expect(res.body.filters.reasonCode).toBe('damaged');
        });

        it('incidentReasonId narrows the numerator of the incident rate', async () => {
            const absent = await get({ incidentReasonId: reasonIds['INC-CUST-ABSENT'] });
            expect(absent.body.kpis.incidentRate).toMatchObject({ numerator: 1, denominator: 4, value: 25 });
            const damaged = await get({ incidentReasonId: reasonIds['INC-PROD-DAMAGED'] });
            expect(damaged.body.kpis.incidentRate).toMatchObject({ numerator: 0, denominator: 4, value: 0 });
        });

        it('rescheduled=true leaves one dispatch (one result) and rescheduled=false the other two', async () => {
            const only = await get({ rescheduled: 'true' });
            expect(only.body.tables.dispatches.data).toHaveLength(1);
            expect(only.body.tables.dispatches.data[0].dispatchId).toBe(dispatchOf.B);
            expect(only.body.kpis.rescheduleRate).toMatchObject({ numerator: 1, denominator: 1, value: 100 });
            expect(only.body.kpis.complaintRate).toMatchObject({ numerator: 1, denominator: 1 });
            const never = await get({ rescheduled: 'false' });
            expect(never.body.tables.dispatches.meta.total).toBe(2);
            expect(never.body.kpis.rescheduleRate).toMatchObject({ numerator: 0, denominator: 2, value: 0 });
        });

        it('all of them together, with the status and the zone', async () => {
            const res = await get({ status: 'delivered', rescheduled: 'true', reasonCode: 'LATE', incidentReasonId: reasonIds['INC-CUST-ABSENT'], timeZone: 'America/La_Paz' });
            expect(res.status).toBe(200);
            expect(res.body.kpis.incidentRate).toMatchObject({ numerator: 1, denominator: 2 });
            expect(res.body.kpis.complaintRate).toMatchObject({ numerator: 1, denominator: 1 });
            expect(res.body.tables.cases.data).toHaveLength(1);
        });

        it('another zone does not see these dispatches', async () => {
            const res = await get({ zoneId: zone.OTHER });
            expect(res.body.tables.dispatches.data.map((d: { dispatchId: number }) => d.dispatchId)).not.toContain(dispatchOf.A);
        });
    });

    describe('zero results and N/D', () => {
        it('a zone with nothing is «Sin datos», never a made-up 0, with empty tables and a 200', async () => {
            const res = await get({ zoneId: zone.EMPTY });
            expect(res.status).toBe(200);
            for (const kpi of [res.body.kpis.incidentRate, res.body.kpis.rescheduleRate, res.body.kpis.complaintRate, res.body.kpis.investigationTime, res.body.kpis.ratingAverage]) {
                expect(kpi).toMatchObject({ available: true, value: null });
            }
            expect(res.body.tables.cases).toEqual({ data: [], meta: { page: 1, limit: 10, pages: 0, total: 0 } });
            expect(res.body.tables.dispatches.data).toEqual([]);
        });

        it('a range that starts before the instrumented period makes the incident rate N/D with its cause and keeps the counts', async () => {
            const res = await get({ from: '2020-04-01' });
            expect(res.body.kpis.incidentRate).toMatchObject({ available: false, value: null, reason: 'attempt_coverage_incomplete', numerator: 1, denominator: 4 });
        });
    });

    describe('validation', () => {
        it('400 for a reversed range, a range over 366 days, another time zone, a bad page size or order', async () => {
            const reversed = await get({ from: '2020-04-30', to: '2020-04-05' });
            expect(reversed.status).toBe(400);
            expect(reversed.body.error).toBe('INVALID_DATE_RANGE');
            const long = await get({ from: '2019-01-01', to: '2020-04-30' });
            expect(long.status).toBe(400);
            expect(long.body.error).toBe('DATE_RANGE_TOO_LARGE');
            expect((await get({ timeZone: 'UTC' })).status).toBe(400);
            expect((await get({ limit: 101 })).status).toBe(400);
            expect((await get({ order: 'sideways' })).status).toBe(400);
            expect((await get({ rescheduled: 'maybe' })).status).toBe(400);
            expect((await get({ from: undefined })).status).toBe(400);
        });
    });
});
