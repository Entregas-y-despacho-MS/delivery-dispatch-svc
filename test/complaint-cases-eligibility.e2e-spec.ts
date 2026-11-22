// ST-45.4 — eligibility, investigation and security of complaint cases (ES-45, RF-U22), through the API as a client.
// Unlike complaint-cases.e2e-spec.ts (ST-45.2), which inserts its cases straight into the table, every case here arrives
// the way it does in production: CRM publishes `crm.delivery_complaint.opened` and the real intake (ST-298.3) stores it.
// That shows what the inbox gets and what it never gets (rejected and duplicated complaints), and then the whole
// investigation is run over the API: actor, time and version of each step, the three verdicts (only `request_RMA` starts
// the RMA flow, and nothing creates a pickup), protected evidence and the denials.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { MessageBus } from '../src/plugins/messaging/message-bus.port.js';
import { TrackedFixtures, type TrackedDispatch } from './helpers/tracked-dispatch.fixtures.js';

const RMA_TOPIC = 'dispatch.rma.authorization_requested';
const EVIDENCE_URL = 'https://evidence.example.test/private/signature-st454.png';

describe('complaint cases: eligibility, investigation and security (e2e, ST-45.4)', () => {
    let app: INestApplication;
    let db: DataSource;
    let api = '';
    let fixtures: TrackedFixtures;
    let batchId = 0;
    let sequence = 0;
    const run = Date.now().toString(36).toUpperCase();
    const crmPrefix = `CRM-ST454-${run}-`;
    const tokens: Record<string, string> = {};
    const userIds: Record<string, number> = {};
    const usernames: string[] = [];
    const messageIds: string[] = [];
    const extraDispatchIds: number[] = [];
    let caseSeq = 0;

    const http = () => request(app.getHttpServer());
    const as = (role: string | null, method: 'get' | 'post', path: string, body?: object) => {
        let call = http()[method](`/${api}${path}`);
        if (role) call = call.set('Authorization', `Bearer ${tokens[role]}`);
        return body ? call.send(body) : call;
    };
    const verdict = (value: string, expectedVersion = 1) => ({
        expectedVersion, verdict: value, decisionReason: `Causal ${value}`, findings: `Hallazgos de la investigación (${value})`,
    });

    /** CRM opens a complaint: it goes through the real intake, exactly like a Pub/Sub message. */
    const crm = async (refs: Record<string, unknown>, over: { crmCaseId?: string; caseVersion?: number; messageId?: string } = {}) => {
        const crmCaseId = over.crmCaseId ?? `${crmPrefix}${++caseSeq}`;
        const messageId = over.messageId ?? uuidv7();
        messageIds.push(messageId);
        await app.get(MessageBus).publish('crm.delivery_complaint.opened', {
            messageId, type: 'crm.delivery_complaint.opened', schemaVersion: 1, source: 'crm', occurredAt: new Date().toISOString(),
            data: { crmCaseId, caseVersion: over.caseVersion ?? 1, reasonCode: 'DAMAGED_ITEM', openedAt: '2026-11-20T15:00:00Z',
                affectedItems: [{ packageId: 'PKG-1', quantity: 1 }], ...refs },
        } as never);
        return { crmCaseId, messageId };
    };
    const casesOf = async (crmCaseId: string): Promise<Array<{ id: number; case_version: number; dispatch_id: number }>> =>
        db.query(`SELECT delivery_complaint_case_id AS id, case_version, dispatch_id FROM delivery_complaint_cases WHERE crm_case_id = $1`, [crmCaseId]);
    const caseIdOf = async (crmCaseId: string) => (await casesOf(crmCaseId))[0]!.id;
    const rmaRequestsOf = async (crmCaseId: string) =>
        (await db.query(`SELECT count(*)::int AS n FROM outbound_messages WHERE type = $1 AND payload->'data'->>'crmCaseId' = $2`, [RMA_TOPIC, crmCaseId]))[0].n as number;
    const nonDeliveryDispatches = async () =>
        (await db.query(`SELECT count(*)::int AS n FROM dispatches d JOIN dispatch_types t USING (dispatch_type_id) WHERE t.name <> 'delivery'`))[0].n as number;
    /** All the inbox, across pages. */
    const inbox = async (query: Record<string, string | number> = {}) => {
        const rows: Array<{ complaintId: number; crmCaseId: string }> = [];
        for (let page = 1; page < 50; page++) {
            const res = await as('coordinator', 'get', `/complaint-cases?limit=100&page=${page}${Object.entries(query).map(([k, v]) => `&${k}=${v}`).join('')}`);
            expect(res.status).toBe(200);
            rows.push(...res.body.data);
            if (page >= res.body.meta.pages) break;
        }
        return rows;
    };
    const newDispatch = async (status = 'delivered') => fixtures.create({ status, routeBatchId: batchId, sequence: ++sequence });

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        api = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(api);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        db = moduleRef.get(DataSource);

        const hash = await hashPassword('E2eTest1234!');
        for (const role of ['coordinator', 'supervisor', 'driver', 'admin']) {
            const username = `e2e_st454_${role}_${run}`.toLowerCase();
            usernames.push(username);
            [{ user_id: userIds[role] }] = await db.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change)
                 VALUES ((SELECT role_id FROM roles WHERE name = $1), $2, $3, $4, false) RETURNING user_id`,
                [role, `ST-45.4 ${role}`, username, hash],
            );
            const login = await http().post(`/${api}/auth/login`).send({ username, password: 'E2eTest1234!' });
            expect(login.status, role).toBe(200);
            tokens[role] = login.body.accessToken;
        }
        fixtures = new TrackedFixtures(db, `ST454${run}`);
        const [warehouse] = await fixtures.warehouses();
        batchId = await fixtures.createBatch({
            shiftDate: '2026-11-20', vehicleId: await fixtures.createVehicle(), zoneId: await fixtures.createZone('C'),
            warehouseId: warehouse!.id, status: 'in_execution',
        });
    });

    afterAll(async () => {
        if (db?.isInitialized) {
            await db.query(`DELETE FROM outbound_messages WHERE payload->'data'->>'crmCaseId' LIKE $1`, [`${crmPrefix}%`]);
            await db.query(`DELETE FROM delivery_complaint_cases WHERE crm_case_id LIKE $1`, [`${crmPrefix}%`]);
            await db.query(`DELETE FROM inbound_messages WHERE message_id = ANY($1::uuid[])`, [messageIds]);
            await db.query(`DELETE FROM delivery_evidences WHERE file_url = $1`, [EVIDENCE_URL]);
            await db.query(`DELETE FROM dispatches WHERE dispatch_id = ANY($1::int[])`, [extraDispatchIds]);
            await fixtures.cleanup();
            await db.query(`DELETE FROM users WHERE username = ANY($1::text[])`, [usernames]);
        }
        await app?.close();
    });

    describe('eligibility: what reaches the inbox', () => {
        it('a delivered dispatch whose batch is still running is investigable right away, and the complaint changes neither', async () => {
            const dispatch = await newDispatch();
            const { crmCaseId } = await crm({ dispatchId: dispatch.dispatchId, trackingCode: dispatch.trackingCode });
            const detail = await as('coordinator', 'get', `/complaint-cases/${await caseIdOf(crmCaseId)}`);
            expect(detail.status).toBe(200);
            expect(detail.body).toMatchObject({
                crmCaseId, dispatchId: dispatch.dispatchId, dispatchStatus: 'delivered', eligible: true,
                investigationStatus: 'received', nextAction: 'assign', routeBatchStatus: 'in_execution', caseVersion: 1,
            });
            const [state] = await db.query(
                `SELECT s.name AS status, b.status AS batch FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id)
                   JOIN route_batches b USING (route_batch_id) WHERE d.dispatch_id = $1`, [dispatch.dispatchId]);
            expect(state).toEqual({ status: 'delivered', batch: 'in_execution' });
        });

        it('a complaint about a dispatch that is not delivered is rejected at intake and never becomes a case', async () => {
            const onTheWay = await newDispatch('in_transit');
            const { crmCaseId } = await crm({ dispatchId: onTheWay.dispatchId });
            expect(await casesOf(crmCaseId)).toEqual([]);
            expect((await inbox()).some((row) => row.crmCaseId === crmCaseId)).toBe(false);
        });

        it('an order with several dispatches: only its delivery can be investigated, the pickup of the same order is rejected', async () => {
            const delivery = await newDispatch();
            const [{ dispatch_id: pickupId, tracking_code: pickupTracking }] = await db.query(
                `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, source_order_ref, delivery_address, contact_name, contact_phone,
                                         estimated_weight_kg, origin_warehouse_id, tracking_code, version, shipment_ready)
                 VALUES ((SELECT dispatch_type_id FROM dispatch_types WHERE name = 'warehouse_return_pickup'),
                         (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'delivered'), $1, 'Calle E2E', 'E2E', '1', 1,
                         (SELECT warehouse_id FROM warehouses WHERE active AND deleted_at IS NULL ORDER BY warehouse_id LIMIT 1),
                         next_tracking_code(), 1, TRUE) RETURNING dispatch_id, tracking_code`,
                [delivery.ref],
            );
            extraDispatchIds.push(Number(pickupId));
            const pickup = await crm({ trackingCode: pickupTracking, salesOrderId: delivery.ref });
            const ofDelivery = await crm({ trackingCode: delivery.trackingCode, salesOrderId: delivery.ref });
            expect(await casesOf(pickup.crmCaseId)).toEqual([]);
            expect(await casesOf(ofDelivery.crmCaseId)).toEqual([expect.objectContaining({ dispatch_id: delivery.dispatchId })]);
        });

        it('a duplicated message stores one case, and a newer version of the case updates it instead of adding another', async () => {
            const dispatch = await newDispatch();
            const first = await crm({ dispatchId: dispatch.dispatchId });
            await crm({ dispatchId: dispatch.dispatchId }, { crmCaseId: first.crmCaseId, messageId: first.messageId });
            expect(await casesOf(first.crmCaseId)).toHaveLength(1);
            await crm({ dispatchId: dispatch.dispatchId }, { crmCaseId: first.crmCaseId, caseVersion: 2 });
            expect(await casesOf(first.crmCaseId)).toEqual([expect.objectContaining({ case_version: 2 })]);
            expect((await inbox()).filter((row) => row.crmCaseId === first.crmCaseId)).toHaveLength(1);
        });
    });

    describe('investigation: actor, time and version of each step', () => {
        it('records who took the case and when, when the investigation started, and who decided and when, on the version read', async () => {
            const dispatch = await newDispatch();
            const { crmCaseId } = await crm({ dispatchId: dispatch.dispatchId });
            const id = await caseIdOf(crmCaseId);
            const before = Date.now();

            const assigned = await as('coordinator', 'post', `/complaint-cases/${id}/assign`, { expectedVersion: 1 });
            expect(assigned.body).toMatchObject({ investigationStatus: 'assigned', assignedUserId: userIds.coordinator, nextAction: 'start_investigation' });
            const started = await as('supervisor', 'post', `/complaint-cases/${id}/start-investigation`, { expectedVersion: 1 });
            expect(started.body).toMatchObject({ investigationStatus: 'in_investigation', nextAction: 'issue_verdict' });
            const decided = await as('supervisor', 'post', `/complaint-cases/${id}/verdict`, verdict('not_confirmed'));
            expect(decided.status).toBe(200);
            expect(decided.body).toMatchObject({
                investigationStatus: 'decided', verdict: 'not_confirmed', decidedByUserId: userIds.supervisor, caseVersion: 1,
                decisionReason: 'Causal not_confirmed', findings: 'Hallazgos de la investigación (not_confirmed)', nextAction: 'none',
            });
            const after = Date.now();
            const times = [decided.body.assignedAt, decided.body.investigationStartedAt, decided.body.decidedAt].map((t: string) => Date.parse(t));
            for (const time of times) {
                expect(time).toBeGreaterThanOrEqual(before - 1_000);
                expect(time).toBeLessThanOrEqual(after + 1_000);
            }
            expect(times).toEqual([...times].sort((a, b) => a - b));
        });

        it('a case already decided cannot be reassigned, reopened or decided otherwise; repeating the same verdict changes nothing', async () => {
            const dispatch = await newDispatch();
            const { crmCaseId } = await crm({ dispatchId: dispatch.dispatchId });
            const id = await caseIdOf(crmCaseId);
            await as('coordinator', 'post', `/complaint-cases/${id}/assign`, { expectedVersion: 1 });
            await as('coordinator', 'post', `/complaint-cases/${id}/start-investigation`, { expectedVersion: 1 });
            const decided = (await as('coordinator', 'post', `/complaint-cases/${id}/verdict`, verdict('no_return_required'))).body;

            expect((await as('supervisor', 'post', `/complaint-cases/${id}/assign`, { expectedVersion: 1, assigneeUserId: userIds.supervisor })).status).toBe(409);
            expect((await as('supervisor', 'post', `/complaint-cases/${id}/start-investigation`, { expectedVersion: 1 })).status).toBe(409);
            expect((await as('supervisor', 'post', `/complaint-cases/${id}/verdict`, verdict('request_RMA'))).status).toBe(409);
            const repeated = await as('supervisor', 'post', `/complaint-cases/${id}/verdict`, verdict('no_return_required'));
            expect(repeated.status).toBe(200);
            expect(repeated.body).toMatchObject({ verdict: 'no_return_required', decidedAt: decided.decidedAt, decidedByUserId: decided.decidedByUserId });
            expect(await rmaRequestsOf(crmCaseId)).toBe(0);
        });
    });

    describe('verdicts: only request_RMA starts the RMA flow', () => {
        it.each(['no_return_required', 'not_confirmed', 'request_RMA'] as const)('%s', async (value) => {
            const dispatch = await newDispatch();
            const { crmCaseId } = await crm({ dispatchId: dispatch.dispatchId });
            const id = await caseIdOf(crmCaseId);
            const pickupsBefore = await nonDeliveryDispatches();
            await as('coordinator', 'post', `/complaint-cases/${id}/assign`, { expectedVersion: 1 });
            await as('coordinator', 'post', `/complaint-cases/${id}/start-investigation`, { expectedVersion: 1 });
            const res = await as('coordinator', 'post', `/complaint-cases/${id}/verdict`, verdict(value));
            expect(res.status).toBe(200);

            const rma = value === 'request_RMA';
            expect(res.body).toMatchObject({
                verdict: value, authorizationPending: rma, nextAction: rma ? 'await_inventory_authorization' : 'none', rmaId: null,
            });
            expect(res.body.authorizationRequestId === null).toBe(!rma);
            expect(await rmaRequestsOf(crmCaseId)).toBe(rma ? 1 : 0);
            // Dispatch never creates the pickup itself (Inventory approves first), never touches the delivery, and sends
            // CRM nothing but its acknowledgement: no closing, refund or replacement.
            expect(await nonDeliveryDispatches()).toBe(pickupsBefore);
            const [state] = await db.query(`SELECT s.name FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id) WHERE d.dispatch_id = $1`, [dispatch.dispatchId]);
            expect(state.name).toBe('delivered');
            const types = (await db.query(`SELECT DISTINCT type FROM outbound_messages WHERE payload->'data'->>'crmCaseId' = $1 ORDER BY type`, [crmCaseId]))
                .map((row: { type: string }) => row.type);
            expect(types).toEqual(rma ? ['dispatch.delivery_complaint.received', RMA_TOPIC] : ['dispatch.delivery_complaint.received']);
        });
    });

    describe('security', () => {
        let caseId = 0;
        let dispatch: TrackedDispatch;

        beforeAll(async () => {
            dispatch = await newDispatch();
            await db.query(
                `INSERT INTO delivery_evidences (delivery_evidence_id, dispatch_id, type, file_url, receiver_name, receiver_document)
                 VALUES ($1, $2, 'signature', $3, 'Receptor Privado', 'CI-9999999')`,
                [uuidv7(), dispatch.dispatchId, EVIDENCE_URL],
            );
            caseId = await caseIdOf((await crm({ dispatchId: dispatch.dispatchId, trackingCode: dispatch.trackingCode })).crmCaseId);
        });

        it('the inbox and the detail never expose the evidence file, the customer\'s data or the tracking link', async () => {
            const detail = await as('supervisor', 'get', `/complaint-cases/${caseId}`);
            const list = await as('supervisor', 'get', `/complaint-cases?limit=100`);
            for (const body of [detail.body, list.body]) {
                const text = JSON.stringify(body);
                for (const secret of [EVIDENCE_URL, 'Receptor Privado', 'CI-9999999', 'Calle Secreta 123', '+591 70000000', 'customer@example.test', 'E2E customer', dispatch.token]) {
                    expect(text).not.toContain(secret);
                }
            }
        });

        it('driver and admin are denied every endpoint, and without a token everything is 401', async () => {
            const endpoints: Array<['get' | 'post', string, object | undefined]> = [
                ['get', '/complaint-cases', undefined],
                ['get', `/complaint-cases/${caseId}`, undefined],
                ['post', `/complaint-cases/${caseId}/assign`, { expectedVersion: 1 }],
                ['post', `/complaint-cases/${caseId}/start-investigation`, { expectedVersion: 1 }],
                ['post', `/complaint-cases/${caseId}/verdict`, verdict('not_confirmed')],
            ];
            for (const [method, path, body] of endpoints) {
                for (const role of ['driver', 'admin']) expect((await as(role, method, path, body)).status, `${role} ${method} ${path}`).toBe(403);
                expect((await as(null, method, path, body)).status, `anonymous ${method} ${path}`).toBe(401);
            }
            const [row] = await db.query(`SELECT investigation_status, assigned_user_id FROM delivery_complaint_cases WHERE delivery_complaint_case_id = $1`, [caseId]);
            expect(row).toEqual({ investigation_status: 'received', assigned_user_id: null });
        });

        it('nothing outside Dispatch can be done from here: no verdict closes, refunds or approves, and there is no endpoint for it', async () => {
            await as('coordinator', 'post', `/complaint-cases/${caseId}/assign`, { expectedVersion: 1 });
            await as('coordinator', 'post', `/complaint-cases/${caseId}/start-investigation`, { expectedVersion: 1 });
            for (const value of ['refund', 'replacement', 'close_case', 'approve_rma', 'REQUEST_RMA']) {
                const res = await as('coordinator', 'post', `/complaint-cases/${caseId}/verdict`, verdict(value));
                expect(res.status, value).toBe(400);
            }
            for (const action of ['close', 'refund', 'approve-rma', 'reject-rma', 'compensate']) {
                expect((await as('coordinator', 'post', `/complaint-cases/${caseId}/${action}`, { expectedVersion: 1 })).status, action).toBe(404);
            }
            const [row] = await db.query(`SELECT investigation_status, verdict FROM delivery_complaint_cases WHERE delivery_complaint_case_id = $1`, [caseId]);
            expect(row).toEqual({ investigation_status: 'in_investigation', verdict: null });
        });

        it('assigning a case to someone outside the inbox roles is refused, and the case stays unassigned', async () => {
            // A case just received, so the only reason to refuse is the assignee.
            const fresh = await newDispatch();
            const id = await caseIdOf((await crm({ dispatchId: fresh.dispatchId })).crmCaseId);
            for (const role of ['driver', 'admin']) {
                const res = await as('coordinator', 'post', `/complaint-cases/${id}/assign`, { expectedVersion: 1, assigneeUserId: userIds[role] });
                expect(res.status, role).toBe(400);
                expect(res.body.error, role).toBe('INVALID_COMPLAINT_ASSIGNEE');
            }
            const [row] = await db.query(`SELECT investigation_status, assigned_user_id FROM delivery_complaint_cases WHERE delivery_complaint_case_id = $1`, [id]);
            expect(row).toEqual({ investigation_status: 'received', assigned_user_id: null });
            // The same command with a supervisor as assignee goes through.
            const ok = await as('coordinator', 'post', `/complaint-cases/${id}/assign`, { expectedVersion: 1, assigneeUserId: userIds.supervisor });
            expect(ok.body).toMatchObject({ investigationStatus: 'assigned', assignedUserId: userIds.supervisor });
        });
    });
});
