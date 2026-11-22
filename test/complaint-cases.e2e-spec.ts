// ST-45.2 — /complaint-cases: bandeja y comandos de asignación, investigación y dictamen (ES-45, RF-U22).
//
// Levanta el AppModule real contra una base real con las migraciones 030 a 032. Todo lo que crea lleva un prefijo único por
// corrida y se borra en afterAll. Los casos de la bandeja viven en 2040: los filtros de fecha de la corrida los aíslan de
// cualquier otro dato de la base compartida.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

const RMA_TOPIC = 'dispatch.rma.authorization_requested';
const WINDOW = { from: '2040-01-01', to: '2040-12-31' };

describe('/complaint-cases (e2e, ST-45.2)', () => {
    let app: INestApplication;
    let db: DataSource;
    let prefix: string;
    const run = Date.now().toString(36).toUpperCase();
    const tag = 'e2e_cc_';
    const crmPrefix = `E2E-${run}-`;
    const reasonA = `E2E${run}A`.slice(0, 40);
    const reasonB = `E2E${run}B`.slice(0, 40);
    const reasonC = `E2E${run}C`.slice(0, 40);
    const tokens: Record<string, string> = {};
    const userIds: Record<string, number> = {};
    const batchIds: number[] = [];
    const vehicleIds: number[] = [];
    const zoneIds: number[] = [];
    const statusIds: Record<string, number> = {};
    let deliveryTypeId: number;
    let activeVehicleStatusId: number;
    let openBatchId: number;
    let keySeq = 0;
    const trackingBase = Date.now() % 100000;

    const http = () => request(app.getHttpServer());
    const api = (path: string) => `/${prefix}${path}`;
    const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
    const list = (query: Record<string, string | number> = {}, role = 'coordinator') =>
        http().get(api('/complaint-cases')).query({ ...WINDOW, ...query }).set(auth(role));
    const detail = (id: number, role = 'coordinator') => http().get(api(`/complaint-cases/${id}`)).set(auth(role));
    const command = (id: number, action: string, body: Record<string, unknown>, role = 'coordinator') =>
        http().post(api(`/complaint-cases/${id}/${action}`)).set(auth(role)).send(body);
    const verdictBody = (verdict: string, expectedVersion = 1) => ({
        expectedVersion, verdict, decisionReason: `Reason for ${verdict}.`, findings: `Findings for ${verdict}: the photos were reviewed.`,
    });

    const createUser = async (key: string, role: string): Promise<void> => {
        const username = `${tag}${key}_${run}`;
        const [{ user_id }] = await db.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change, active)
             VALUES ((SELECT role_id FROM roles WHERE name = $1), $2, $3, $4, FALSE, TRUE) RETURNING user_id`,
            [role, `Cc ${key} ${run}`, username, await hashPassword('E2eTest1234')],
        );
        userIds[key] = user_id as number;
        const res = await http().post(api('/auth/login')).send({ username, password: 'E2eTest1234' });
        tokens[key] = res.body.accessToken as string;
    };

    interface CaseOptions {
        status?: string;            // dispatch status
        zone?: number | null;
        batch?: number | null;
        reason?: string;
        consumedAt?: string;
        caseVersion?: number;
        trackingOnCase?: string | null; // overrides the tracking code stored on the case
        dispatchType?: string;
        investigation?: 'received' | 'assigned' | 'in_investigation' | 'decided';
        assignedTo?: string;        // user key
    }
    interface Fixture { caseId: number; dispatchId: number; crmCaseId: string; ref: string; tracking: string }

    /** One delivery dispatch and the complaint case that points at it, in the state a test needs. */
    const makeCase = async (options: CaseOptions = {}): Promise<Fixture> => {
        const key = String(++keySeq);
        const ref = `CC-${run}-${key}`;
        // The contract of the RMA request requires the real tracking code format (DSP-AAAA-NNNNN); unique per run and key.
        const tracking = `DSP-2040-${String((trackingBase + keySeq) % 100000).padStart(5, '0')}`;
        const crmCaseId = `${crmPrefix}${key}`;
        const status = options.status ?? 'delivered';
        const [{ dispatch_type_id }] = options.dispatchType
            ? await db.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = $1`, [options.dispatchType])
            : [{ dispatch_type_id: deliveryTypeId }];
        const [{ dispatch_id }] = await db.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, delivery_zone_id, route_batch_id, source_order_ref, tracking_code,
                                     delivery_address, contact_name, closed_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'Av. Privada 123 e2e', $7, $8) RETURNING dispatch_id`,
            [dispatch_type_id, statusIds[status], options.zone ?? null, options.batch ?? null, ref, tracking, `Cliente Privado ${key}`,
                ['delivered', 'returned', 'cancelled'].includes(status) ? '2040-02-01T15:00:00.000Z' : null],
        );

        const state = options.investigation ?? 'received';
        // Outside WINDOW (2040) by default: only the inbox suite places its cases inside it.
        const consumedAt = options.consumedAt ?? '2041-06-01T15:00:00.000Z';
        const assignee = state === 'received' ? null : userIds[options.assignedTo ?? 'coordinator'];
        const [{ delivery_complaint_case_id }] = await db.query(
            `INSERT INTO delivery_complaint_cases
                (message_id, source, crm_case_id, case_version, dispatch_id, tracking_code, reason_code, affected_items, opened_at,
                 consumed_at, intake_status, acknowledged_at, investigation_status, assigned_user_id, assigned_at, investigation_started_at,
                 verdict, decision_reason, findings, decided_by_user_id, decided_at)
             VALUES (gen_random_uuid(), 'crm', $1, $2, $3, $4, $5, $6::jsonb, $7, $7, 'acknowledged', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
             RETURNING delivery_complaint_case_id`,
            [
                crmCaseId, options.caseVersion ?? 1, dispatch_id, options.trackingOnCase === undefined ? tracking : options.trackingOnCase,
                options.reason ?? reasonA, JSON.stringify([{ itemCode: `SKU-${key}`, quantity: 2 }]), consumedAt, state, assignee,
                assignee ? consumedAt : null, ['in_investigation', 'decided'].includes(state) ? consumedAt : null,
                state === 'decided' ? 'not_confirmed' : null, state === 'decided' ? 'Seeded reason.' : null,
                state === 'decided' ? 'Seeded findings.' : null, state === 'decided' ? assignee : null, state === 'decided' ? consumedAt : null,
            ],
        );
        return { caseId: delivery_complaint_case_id as number, dispatchId: dispatch_id as number, crmCaseId, ref, tracking };
    };

    const rmaMessages = (crmCaseId: string) => db.query(
        `SELECT message_id, type, payload FROM outbound_messages WHERE type = $1 AND payload->'data'->>'crmCaseId' = $2`,
        [RMA_TOPIC, crmCaseId],
    );
    const dbCase = async (caseId: number) => (await db.query(
        `SELECT investigation_status, verdict, assigned_user_id, authorization_request_id, rma_id, case_version
           FROM delivery_complaint_cases WHERE delivery_complaint_case_id = $1`, [caseId]))[0];

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        prefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(prefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        db = moduleRef.get(DataSource);

        [{ vehicle_status_id: activeVehicleStatusId }] = await db.query(`SELECT vehicle_status_id FROM vehicle_statuses WHERE name = 'active'`);
        [{ dispatch_type_id: deliveryTypeId }] = await db.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);
        for (const s of await db.query(`SELECT dispatch_status_id AS id, name FROM dispatch_statuses`)) statusIds[s.name] = s.id;

        await createUser('coordinator', 'coordinator');
        await createUser('supervisor', 'supervisor');
        await createUser('admin', 'admin');
        await createUser('driver', 'driver');

        for (const key of ['1', '2']) {
            const [{ delivery_zone_id }] = await db.query(
                `INSERT INTO delivery_zones (code, name, estimated_time_min) VALUES ($1, $2, 60) RETURNING delivery_zone_id`,
                [`ZC${run}${key}`.slice(0, 20), `E2E CC ${run} ${key}`],
            );
            zoneIds.push(delivery_zone_id as number);
        }

        // The route batch of the delivered dispatches is still running: the complaint must not wait for its closing.
        const [{ vehicle_id }] = await db.query(
            `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3)
             VALUES ($1, 'van', 'Hiace e2e', $2, 100, 10) RETURNING vehicle_id`,
            [activeVehicleStatusId, `CC${run.slice(-6)}`],
        );
        vehicleIds.push(vehicle_id as number);
        const [{ route_batch_id }] = await db.query(
            `INSERT INTO route_batches (status, shift_date, driver_id, vehicle_id, version)
             VALUES ('in_execution', '2040-02-01', $1, $2, 0) RETURNING route_batch_id`,
            [userIds.driver, vehicle_id],
        );
        openBatchId = route_batch_id as number;
        batchIds.push(openBatchId);
    });

    afterAll(async () => {
        if (db) {
            await db.query(`DELETE FROM outbound_messages WHERE payload->'data'->>'crmCaseId' LIKE $1`, [`${crmPrefix}%`]);
            await db.query(`DELETE FROM delivery_complaint_cases WHERE crm_case_id LIKE $1`, [`${crmPrefix}%`]);
            await withEventPurge(db, { dispatchRefs: [`CC-${run}-%`], routeBatchIds: batchIds, userNames: [`${tag}%_${run}`] }, async (manager) => {
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`CC-${run}-%`]);
                await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
                await manager.query(`DELETE FROM vehicles WHERE vehicle_id = ANY($1::int[])`, [vehicleIds]);
                await manager.query(`DELETE FROM delivery_zones WHERE delivery_zone_id = ANY($1::int[])`, [zoneIds]);
                await manager.query(`DELETE FROM users WHERE username LIKE $1`, [`${tag}%_${run}`]);
            });
        }
        await app?.close();
    });

    describe('acceso', () => {
        it('sin token → 401 en todos los endpoints', async () => {
            expect((await http().get(api('/complaint-cases'))).status).toBe(401);
            expect((await http().get(api('/complaint-cases/1'))).status).toBe(401);
            for (const action of ['assign', 'start-investigation', 'verdict']) {
                expect((await http().post(api(`/complaint-cases/1/${action}`)).send({})).status).toBe(401);
            }
        });

        it.each(['driver', 'admin'])('rol %s → 403 y el caso no cambia', async (role) => {
            const fx = await makeCase();

            expect((await list({}, role)).status).toBe(403);
            expect((await detail(fx.caseId, role)).status).toBe(403);
            for (const action of ['assign', 'start-investigation', 'verdict']) {
                const res = await command(fx.caseId, action, verdictBody('not_confirmed'), role);
                expect(res.status).toBe(403);
                expect(res.body.error).toBe('INSUFFICIENT_PERMISSIONS');
            }
            expect((await dbCase(fx.caseId)).investigation_status).toBe('received');
        });

        it.each(['coordinator', 'supervisor'])('rol %s puede consultar y operar', async (role) => {
            const fx = await makeCase();

            expect((await list({}, role)).status).toBe(200);
            expect((await detail(fx.caseId, role)).status).toBe(200);
            expect((await command(fx.caseId, 'assign', { expectedVersion: 1 }, role)).status).toBe(200);
        });
    });

    describe('bandeja: GET /complaint-cases', () => {
        let c1: Fixture; let c2: Fixture; let c3: Fixture; let c4: Fixture; let c5: Fixture;

        beforeAll(async () => {
            // Reason A: c1, c2, c5 (zone 1) · reason B: c3, c4 (zone 2) · reason C: one case.
            c1 = await makeCase({ zone: zoneIds[0], batch: openBatchId, reason: reasonA, consumedAt: '2040-03-10T15:00:00.000Z' });
            // 2040-03-10 23:30 in La Paz (UTC-4) is already 2040-03-11 03:30 UTC: the Bolivia day decides the range.
            c2 = await makeCase({ zone: zoneIds[0], reason: reasonA, consumedAt: '2040-03-11T03:30:00.000Z' });
            c3 = await makeCase({ zone: zoneIds[1], batch: openBatchId, reason: reasonB, consumedAt: '2040-03-20T15:00:00.000Z', investigation: 'assigned', assignedTo: 'supervisor' });
            c4 = await makeCase({ zone: zoneIds[1], status: 'returned', reason: reasonB, consumedAt: '2040-04-01T15:00:00.000Z' });
            c5 = await makeCase({ zone: zoneIds[0], reason: reasonA, consumedAt: '2040-05-01T15:00:00.000Z', investigation: 'decided' });
            await makeCase({ reason: reasonC, consumedAt: '2040-07-01T15:00:00.000Z' });
        });

        const ids = (body: { data: { complaintId: number }[] }) => body.data.map((item) => item.complaintId);

        it('cero resultados → data vacía y meta en cero', async () => {
            const res = await list({ reasonCode: `NONE${run}` });

            expect(res.status).toBe(200);
            expect(res.body.data).toEqual([]);
            expect(res.body.meta).toEqual({ page: 1, limit: 10, total: 0, pages: 0 });
        });

        it('un resultado', async () => {
            const res = await list({ reasonCode: reasonC });

            expect(res.status).toBe(200);
            expect(res.body.data).toHaveLength(1);
            expect(res.body.meta.total).toBe(1);
        });

        it('muchos resultados, del más reciente al más antiguo, con paginación', async () => {
            const all = await list();
            expect(all.body.meta.total).toBe(6);
            const dates = all.body.data.map((item: { receivedAt: string }) => item.receivedAt);
            expect(dates).toEqual([...dates].sort().reverse());

            const first = await list({ limit: 4, page: 1 });
            const second = await list({ limit: 4, page: 2 });
            expect(first.body.meta).toEqual({ page: 1, limit: 4, total: 6, pages: 2 });
            expect(first.body.data).toHaveLength(4);
            expect(second.body.data).toHaveLength(2);
            expect([...ids(first.body), ...ids(second.body)]).toEqual(ids(all.body));
        });

        it('el filtro de fecha usa el día de Bolivia, incluye ambos extremos y rechaza un rango invertido', async () => {
            expect(ids((await list({ from: '2040-03-10', to: '2040-03-10' })).body).sort()).toEqual([c1.caseId, c2.caseId].sort());
            expect(ids((await list({ from: '2040-03-11', to: '2040-03-20' })).body)).toEqual([c3.caseId]);
            expect((await list({ from: '2040-03-11', to: '2040-03-10' })).body.error).toBe('INVALID_DATE_RANGE');
            expect((await list({ from: '2040-03-11', to: '2040-03-10' })).status).toBe(400);
            expect((await list({ from: '10/03/2040' })).status).toBe(400);
        });

        it('filtra por zona, motivo, estado y responsable, y combina filtros', async () => {
            expect(ids((await list({ zoneId: zoneIds[1] })).body).sort()).toEqual([c3.caseId, c4.caseId].sort());
            expect(ids((await list({ reasonCode: reasonB.toLowerCase() })).body).sort()).toEqual([c3.caseId, c4.caseId].sort());
            expect(ids((await list({ status: 'assigned' })).body)).toEqual([c3.caseId]);
            expect(ids((await list({ status: 'decided' })).body)).toEqual([c5.caseId]);
            expect(ids((await list({ assignedUserId: userIds.supervisor })).body)).toEqual([c3.caseId]);
            expect(ids((await list({ zoneId: zoneIds[1], status: 'received' })).body)).toEqual([c4.caseId]);
            expect((await list({ zoneId: zoneIds[0], reasonCode: reasonB })).body.data).toEqual([]);
        });

        it('parámetros inválidos → 400', async () => {
            expect((await list({ status: 'closed' })).status).toBe(400);
            expect((await list({ zoneId: 'x' })).status).toBe(400);
            expect((await list({ limit: 101 })).status).toBe(400);
            expect((await list({ page: 0 })).status).toBe(400);
        });

        it('responde identificadores, versión, fechas, estado y siguiente acción, sin datos del cliente', async () => {
            const res = await list({ reasonCode: reasonC });
            const [item] = res.body.data;

            expect(Object.keys(item).sort()).toEqual([
                'assignedAt', 'assignedUserId', 'assignedUserName', 'authorizationPending', 'caseVersion', 'complaintId', 'crmCaseId',
                'decidedAt', 'dispatchId', 'dispatchStatus', 'eligible', 'investigationStatus', 'nextAction', 'openedAt', 'reasonCode',
                'receivedAt', 'trackingCode', 'updatedAt', 'verdict', 'zoneId', 'zoneName',
            ]);
            expect(item).toMatchObject({ caseVersion: 1, investigationStatus: 'received', nextAction: 'assign', eligible: true, dispatchStatus: 'delivered' });
            const text = JSON.stringify(res.body);
            expect(text).not.toContain('Cliente Privado');
            expect(text).not.toContain('Av. Privada');
        });

        it('un caso con el lote en ejecución se puede consultar sin esperar el cierre del lote', async () => {
            const res = await detail(c1.caseId);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                complaintId: c1.caseId, crmCaseId: c1.crmCaseId, dispatchId: c1.dispatchId, eligible: true, nextAction: 'assign',
                routeBatchId: openBatchId, routeBatchStatus: 'in_execution', zoneName: `E2E CC ${run} 1`,
            });
            expect(res.body.affectedItems).toEqual([{ itemCode: `SKU-${keySeqOf(c1)}`, quantity: 2 }]);
            expect(JSON.stringify(res.body)).not.toContain('Cliente Privado');
        });

        it('un caso cuyo despacho no está entregado sale como no elegible y sin acción', async () => {
            const res = await detail(c4.caseId);

            expect(res.body).toMatchObject({ eligible: false, dispatchStatus: 'returned', nextAction: 'none' });
        });

        it('detalle inexistente → 404 y id inválido → 400', async () => {
            const missing = await detail(2147483647);
            expect(missing.status).toBe(404);
            expect(missing.body.error).toBe('COMPLAINT_CASE_NOT_FOUND');
            expect((await detail('abc' as never)).status).toBe(400);
        });
    });

    const keySeqOf = (fx: Fixture) => fx.crmCaseId.slice(crmPrefix.length);

    describe('comandos: asignar, investigar y dictaminar', () => {
        const walkToInvestigation = async (fx: Fixture) => {
            expect((await command(fx.caseId, 'assign', { expectedVersion: 1 })).status).toBe(200);
            expect((await command(fx.caseId, 'start-investigation', { expectedVersion: 1 })).status).toBe(200);
        };

        it.each(['no_return_required', 'not_confirmed'])('dictamen %s: guarda actor, instante y causal, y no pide ni crea nada', async (verdict) => {
            const fx = await makeCase({ zone: zoneIds[0], batch: openBatchId });

            const assigned = await command(fx.caseId, 'assign', { expectedVersion: 1 });
            expect(assigned.body).toMatchObject({ investigationStatus: 'assigned', assignedUserId: userIds.coordinator, nextAction: 'start_investigation' });
            expect(assigned.body.assignedAt).toEqual(expect.any(String));

            const started = await command(fx.caseId, 'start-investigation', { expectedVersion: 1 });
            expect(started.body).toMatchObject({ investigationStatus: 'in_investigation', nextAction: 'issue_verdict' });
            expect(started.body.investigationStartedAt).toEqual(expect.any(String));

            const decided = await command(fx.caseId, 'verdict', verdictBody(verdict), 'supervisor');
            expect(decided.status).toBe(200);
            expect(decided.body).toMatchObject({
                investigationStatus: 'decided', verdict, decisionReason: `Reason for ${verdict}.`, nextAction: 'none',
                authorizationPending: false, authorizationRequestId: null, rmaId: null, decidedByUserId: userIds.supervisor,
                assignedUserId: userIds.coordinator,
            });
            expect(decided.body.decidedAt).toEqual(expect.any(String));
            expect(decided.body.findings).toContain('the photos were reviewed');

            expect(await rmaMessages(fx.crmCaseId)).toHaveLength(0);
            expect(await db.query(`SELECT 1 FROM dispatches WHERE source_order_ref = $1`, [fx.ref])).toHaveLength(1);
        });

        it('dictamen request_RMA: queda authorization_pending y publica la solicitud solo por el outbox, sin crear recojo', async () => {
            const fx = await makeCase({ zone: zoneIds[0], batch: openBatchId });
            await walkToInvestigation(fx);

            const res = await command(fx.caseId, 'verdict', verdictBody('request_RMA'));

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ investigationStatus: 'decided', verdict: 'request_RMA', authorizationPending: true, nextAction: 'await_inventory_authorization', rmaId: null });
            const messages = await rmaMessages(fx.crmCaseId);
            expect(messages).toHaveLength(1);
            const { payload } = messages[0];
            expect(res.body.authorizationRequestId).toBe(messages[0].message_id);
            expect(payload).toMatchObject({ type: RMA_TOPIC, source: 'dispatch', messageId: messages[0].message_id });
            expect(payload.data).toMatchObject({
                authorizationRequestId: messages[0].message_id, crmCaseId: fx.crmCaseId, caseVersion: 1, dispatchId: fx.dispatchId,
                trackingCode: fx.tracking, salesOrderId: fx.ref, reasonCode: reasonA, affectedItems: [{ itemCode: `SKU-${keySeqOf(fx)}`, quantity: 2 }],
            });
            expect(JSON.stringify(payload)).not.toContain('Cliente Privado');

            // No pickup yet (only Inventory approves), and neither the dispatch nor its batch moved.
            expect(await db.query(`SELECT 1 FROM dispatches WHERE source_order_ref = $1`, [fx.ref])).toHaveLength(1);
            expect((await db.query(`SELECT s.name FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id) WHERE d.dispatch_id = $1`, [fx.dispatchId]))[0].name).toBe('delivered');
            expect((await db.query(`SELECT status FROM route_batches WHERE route_batch_id = $1`, [openBatchId]))[0].status).toBe('in_execution');
        });

        it('el supervisor puede asignar a otro responsable activo, pero no a un conductor ni a un usuario inexistente', async () => {
            const fx = await makeCase();

            const bad = await command(fx.caseId, 'assign', { expectedVersion: 1, assigneeUserId: userIds.driver });
            expect(bad.status).toBe(400);
            expect(bad.body.error).toBe('INVALID_COMPLAINT_ASSIGNEE');
            expect((await command(fx.caseId, 'assign', { expectedVersion: 1, assigneeUserId: 2147483647 })).body.error).toBe('INVALID_COMPLAINT_ASSIGNEE');
            expect((await dbCase(fx.caseId)).investigation_status).toBe('received');

            const ok = await command(fx.caseId, 'assign', { expectedVersion: 1, assigneeUserId: userIds.supervisor });
            expect(ok.body).toMatchObject({ assignedUserId: userIds.supervisor, assignedUserName: `Cc supervisor ${run}` });
        });

        it('rechaza dictámenes fuera de los tres permitidos y exige causal y hallazgos', async () => {
            const fx = await makeCase();
            await walkToInvestigation(fx);

            for (const verdict of ['refund', 'restock', 'close_case', 'REQUEST_RMA']) {
                expect((await command(fx.caseId, 'verdict', verdictBody(verdict))).status).toBe(400);
            }
            expect((await command(fx.caseId, 'verdict', { ...verdictBody('not_confirmed'), decisionReason: '  ' })).status).toBe(400);
            expect((await command(fx.caseId, 'verdict', { ...verdictBody('not_confirmed'), findings: undefined })).status).toBe(400);
            expect((await command(fx.caseId, 'verdict', { ...verdictBody('not_confirmed'), findings: 'Proof: https://files.example.com/p.jpg' })).status).toBe(400);
            expect((await command(fx.caseId, 'verdict', { ...verdictBody('not_confirmed'), expectedVersion: 0 })).status).toBe(400);
            expect((await dbCase(fx.caseId)).investigation_status).toBe('in_investigation');
        });

        it('rechaza transiciones inválidas con 409 y no cambia el caso', async () => {
            const received = await makeCase();
            const startFirst = await command(received.caseId, 'start-investigation', { expectedVersion: 1 });
            expect(startFirst.status).toBe(409);
            expect(startFirst.body.error).toBe('INVALID_COMPLAINT_TRANSITION');
            expect((await command(received.caseId, 'verdict', verdictBody('not_confirmed'))).status).toBe(409);
            expect((await dbCase(received.caseId)).investigation_status).toBe('received');

            const assigned = await makeCase({ investigation: 'assigned' });
            expect((await command(assigned.caseId, 'verdict', verdictBody('not_confirmed'))).status).toBe(409);

            const investigating = await makeCase({ investigation: 'in_investigation' });
            expect((await command(investigating.caseId, 'assign', { expectedVersion: 1 })).status).toBe(409);

            const decided = await makeCase({ investigation: 'decided' });
            for (const [action, body] of [['assign', { expectedVersion: 1 }], ['start-investigation', { expectedVersion: 1 }], ['verdict', verdictBody('request_RMA')]] as const) {
                const res = await command(decided.caseId, action, body);
                expect(res.status).toBe(409);
                expect(res.body.error).toBe('INVALID_COMPLAINT_TRANSITION');
            }
            expect((await dbCase(decided.caseId)).verdict).toBe('not_confirmed');
            expect(await rmaMessages(decided.crmCaseId)).toHaveLength(0);
        });

        it('rechaza una versión vieja con 409 y no cambia nada', async () => {
            const fx = await makeCase({ caseVersion: 3 });

            const res = await command(fx.caseId, 'assign', { expectedVersion: 2 });

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('COMPLAINT_CASE_VERSION_STALE');
            expect((await dbCase(fx.caseId)).investigation_status).toBe('received');
            expect((await command(fx.caseId, 'assign', { expectedVersion: 3 })).status).toBe(200);
        });

        it('si CRM sube la versión durante la investigación, el dictamen con la versión leída se rechaza', async () => {
            const fx = await makeCase({ investigation: 'in_investigation' });
            await db.query(`UPDATE delivery_complaint_cases SET case_version = 2 WHERE delivery_complaint_case_id = $1`, [fx.caseId]);

            const res = await command(fx.caseId, 'verdict', verdictBody('request_RMA', 1));

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('COMPLAINT_CASE_VERSION_STALE');
            expect((await dbCase(fx.caseId)).investigation_status).toBe('in_investigation');
            expect(await rmaMessages(fx.crmCaseId)).toHaveLength(0);
        });

        it('rechaza un despacho no entregado (422) en los tres comandos', async () => {
            const received = await makeCase({ status: 'returned' });
            const assigned = await makeCase({ status: 'cancelled', investigation: 'assigned' });
            const investigating = await makeCase({ status: 'in_transit', investigation: 'in_investigation' });

            for (const [fx, action, body] of [
                [received, 'assign', { expectedVersion: 1 }],
                [assigned, 'start-investigation', { expectedVersion: 1 }],
                [investigating, 'verdict', verdictBody('request_RMA')],
            ] as const) {
                const res = await command(fx.caseId, action, body);
                expect(res.status).toBe(422);
                expect(res.body.error).toBe('COMPLAINT_DISPATCH_NOT_DELIVERED');
            }
            expect(await rmaMessages(investigating.crmCaseId)).toHaveLength(0);
        });

        it('rechaza una referencia no correlacionada (422): otro tracking, otro tipo de despacho', async () => {
            const wrongTracking = await makeCase({ trackingOnCase: 'DSP-0000-00000' });
            const wrongType = await makeCase({ dispatchType: 'supplier_pickup' });

            for (const fx of [wrongTracking, wrongType]) {
                const res = await command(fx.caseId, 'assign', { expectedVersion: 1 });
                expect(res.status).toBe(422);
                expect(res.body.error).toBe('COMPLAINT_REFERENCE_NOT_CORRELATED');
                expect((await dbCase(fx.caseId)).investigation_status).toBe('received');
            }
        });

        it('comando sobre un caso inexistente → 404', async () => {
            const res = await command(2147483647, 'assign', { expectedVersion: 1 });

            expect(res.status).toBe(404);
            expect(res.body.error).toBe('COMPLAINT_CASE_NOT_FOUND');
        });

        describe('idempotencia', () => {
            it('repetir asignar, iniciar y el dictamen request_RMA no cambia nada ni publica una segunda solicitud', async () => {
                const fx = await makeCase();

                const assigned = await command(fx.caseId, 'assign', { expectedVersion: 1 });
                const assignedAgain = await command(fx.caseId, 'assign', { expectedVersion: 1 });
                expect(assignedAgain.status).toBe(200);
                expect(assignedAgain.body).toEqual(assigned.body);

                const started = await command(fx.caseId, 'start-investigation', { expectedVersion: 1 });
                expect((await command(fx.caseId, 'start-investigation', { expectedVersion: 1 })).body).toEqual(started.body);

                const decided = await command(fx.caseId, 'verdict', verdictBody('request_RMA'));
                const decidedAgain = await command(fx.caseId, 'verdict', verdictBody('request_RMA'));
                expect(decidedAgain.status).toBe(200);
                expect(decidedAgain.body).toEqual(decided.body);
                expect(await rmaMessages(fx.crmCaseId)).toHaveLength(1);
            });

            it('una versión atrasada no revierte el dictamen vigente', async () => {
                const fx = await makeCase();
                await walkToInvestigation(fx);
                await command(fx.caseId, 'verdict', verdictBody('not_confirmed'));
                await db.query(`UPDATE delivery_complaint_cases SET case_version = 2 WHERE delivery_complaint_case_id = $1`, [fx.caseId]);

                const same = await command(fx.caseId, 'verdict', verdictBody('not_confirmed', 1));
                expect(same.status).toBe(200);
                const other = await command(fx.caseId, 'verdict', verdictBody('request_RMA', 1));
                expect(other.status).toBe(409);

                expect((await dbCase(fx.caseId)).verdict).toBe('not_confirmed');
                expect(await rmaMessages(fx.crmCaseId)).toHaveLength(0);
            });

            it('dos dictámenes request_RMA simultáneos publican una sola solicitud', async () => {
                const fx = await makeCase();
                await walkToInvestigation(fx);

                const [a, b] = await Promise.all([
                    command(fx.caseId, 'verdict', verdictBody('request_RMA')),
                    command(fx.caseId, 'verdict', verdictBody('request_RMA'), 'supervisor'),
                ]);

                expect([a.status, b.status]).toEqual([200, 200]);
                expect(await rmaMessages(fx.crmCaseId)).toHaveLength(1);
                expect(a.body.authorizationRequestId).toBe(b.body.authorizationRequestId);
            });

            it('dos asignaciones distintas simultáneas no se pisan: gana una y la otra es idempotente o falla limpio', async () => {
                const fx = await makeCase();

                const results = await Promise.all([
                    command(fx.caseId, 'assign', { expectedVersion: 1, assigneeUserId: userIds.coordinator }),
                    command(fx.caseId, 'assign', { expectedVersion: 1, assigneeUserId: userIds.supervisor }),
                ]);

                expect(results.map((res) => res.status)).toEqual([200, 200]);
                const stored = (await dbCase(fx.caseId)).assigned_user_id;
                expect([userIds.coordinator, userIds.supervisor]).toContain(stored);
            });
        });
    });
});
