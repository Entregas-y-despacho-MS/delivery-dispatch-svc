import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { MailerPort } from '../src/plugins/mailer/mailer.port.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

describe('POST /route-batches/:id/approve-promises (e2e)', () => {
    let app: INestApplication;
    let db: DataSource;
    let prefix: string;
    let reviewerId: number;
    let otherReviewerId: number;
    let reviewerToken: string;
    let otherReviewerToken: string;
    const run = Date.now().toString(36);
    const sourceRefs: string[] = [];
    const batchIds: number[] = [];
    const vehicleIds: number[] = [];
    const userIds: number[] = [];
    const sent: any[] = [];

    const http = () => request(app.getHttpServer());
    const api = (path: string) => `/${prefix}${path}`;
    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(MailerPort).useValue({ send: async (options: any) => { sent.push(options); return { status: 'sent' }; } })
            .compile();
        app = moduleRef.createNestApplication();
        prefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(prefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        db = moduleRef.get(DataSource);

        const [{ role_id: coordinatorRoleId }] = await db.query(`SELECT role_id FROM roles WHERE name = 'coordinator'`);
        const passwordHash = await hashPassword('E2eTest1234');
        const users = await db.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, active, requires_pwd_change)
             VALUES ($1, $2, $3, $4, TRUE, FALSE), ($1, $5, $6, $4, TRUE, FALSE)
             RETURNING user_id, username`,
            [coordinatorRoleId, `ES215 reviewer ${run}`, `es215_reviewer_${run}`, passwordHash, `ES215 other ${run}`, `es215_other_${run}`],
        );
        reviewerId = users[0].user_id;
        otherReviewerId = users[1].user_id;
        userIds.push(reviewerId, otherReviewerId);
        reviewerToken = (await http().post(api('/auth/login')).send({ username: users[0].username, password: 'E2eTest1234' })).body.accessToken;
        otherReviewerToken = (await http().post(api('/auth/login')).send({ username: users[1].username, password: 'E2eTest1234' })).body.accessToken;
    });

    afterAll(async () => {
        if (db) {
            await withEventPurge(db, { dispatchRefs: sourceRefs.map((ref) => `${ref}%`), routeBatchIds: batchIds }, async (manager) => {
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref = ANY($1::text[])`, [sourceRefs]);
                await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
                await manager.query(`DELETE FROM vehicles WHERE vehicle_id = ANY($1::int[])`, [vehicleIds]);
                await manager.query(`DELETE FROM users WHERE user_id = ANY($1::int[])`, [userIds]);
            });
        }
        await app?.close();
    });

    async function fixture(email: string | null = 'customer@example.test') {
        const [{ vehicle_status_id: activeVehicleStatusId }] = await db.query(`SELECT vehicle_status_id FROM vehicle_statuses WHERE name = 'active'`);
        const [{ dispatch_type_id: deliveryTypeId }] = await db.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);
        const [{ dispatch_status_id: planningStatusId }] = await db.query(`SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'in_planning'`);
        const [{ vehicle_id: vehicleId }] = await db.query(
            `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3)
             VALUES ($1, 'van', 'ES215 e2e', $2, 100, 10) RETURNING vehicle_id`,
            [activeVehicleStatusId, `E${run.slice(-5)}${vehicleIds.length}`],
        );
        vehicleIds.push(vehicleId);
        const [{ route_batch_id: routeBatchId }] = await db.query(
            `INSERT INTO route_batches (status, reviewer_user_id, vehicle_id, shift_date)
             VALUES ('provisional', $1, $2, '2026-10-20') RETURNING route_batch_id`,
            [reviewerId, vehicleId],
        );
        batchIds.push(routeBatchId);
        const ref = `ES215-${run}-${sourceRefs.length}`;
        sourceRefs.push(ref);
        const [{ dispatch_id: dispatchId }] = await db.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order,
                source_order_ref, delivery_address, contact_name, contact_email, estimated_weight_kg,
                scheduled_window_start, scheduled_window_end)
             VALUES ($1, $2, $3, 1, $4, 'Test address', 'E2E customer', $5, 1,
                '2026-10-20T13:00:00Z', '2026-10-20T15:00:00Z') RETURNING dispatch_id`,
            [deliveryTypeId, planningStatusId, routeBatchId, ref, email],
        );
        return { routeBatchId: Number(routeBatchId), dispatchId: Number(dispatchId) };
    }

    it('approves a promise, removes selected dispatches, sends after commit, and records audit events', async () => {
        const kept = await fixture();
        const removed = await fixture(null);
        // Keep both dispatches in one batch for the removal case.
        await db.query(`UPDATE dispatches SET route_batch_id = $1, sequence_order = 2 WHERE dispatch_id = $2`, [kept.routeBatchId, removed.dispatchId]);
        await db.query(`DELETE FROM route_batches WHERE route_batch_id = $1`, [removed.routeBatchId]);
        batchIds.splice(batchIds.indexOf(removed.routeBatchId), 1);

        const response = await http().post(api(`/route-batches/${kept.routeBatchId}/approve-promises`))
            .set(auth(reviewerToken))
            .send({ version: 0, dispatches: [{ dispatchId: kept.dispatchId, version: 0 }, { dispatchId: removed.dispatchId, version: 0 }], removeDispatchIds: [removed.dispatchId] });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ routeBatchId: kept.routeBatchId, version: 1, approvedCount: 1, removedCount: 1, emailCount: 1 });
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ template: 'promise', metadata: { dispatchId: kept.dispatchId, routeBatchId: kept.routeBatchId } });

        const rows = await db.query(
            `SELECT d.dispatch_id, s.name AS status, d.route_batch_id, d.version, d.tracking_token,
                    d.tracking_token_expires_at, d.promise_notified_at
               FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id)
              WHERE d.dispatch_id = ANY($1::int[]) ORDER BY d.dispatch_id`,
            [[kept.dispatchId, removed.dispatchId]],
        );
        expect(rows[0]).toMatchObject({ status: 'scheduled', route_batch_id: kept.routeBatchId, version: 1 });
        expect(rows[0].tracking_token).toBeTruthy();
        expect(rows[0].tracking_token_expires_at).toBeNull();
        expect(rows[0].promise_notified_at).toBeTruthy();
        expect(rows[1]).toMatchObject({ status: 'pending', route_batch_id: null, version: 1 });
        expect(await db.query(`SELECT event_type FROM route_batch_events WHERE route_batch_id = $1`, [kept.routeBatchId]))
            .toEqual(expect.arrayContaining([expect.objectContaining({ event_type: 'promises_approved' }), expect.objectContaining({ event_type: 'dispatch_removed_before_approval' })]));
    });

    it('returns 409 on stale version without sending an email', async () => {
        const { routeBatchId, dispatchId } = await fixture();
        const before = sent.length;
        const response = await http().post(api(`/route-batches/${routeBatchId}/approve-promises`))
            .set(auth(reviewerToken)).send({ version: 5, dispatches: [{ dispatchId, version: 0 }] });
        expect(response.status).toBe(409);
        expect(response.body.error).toBe('ROUTE_BATCH_VERSION_CONFLICT');
        expect(sent).toHaveLength(before);
    });

    it('forbids a coordinator from approving another reviewer’s batch', async () => {
        const { routeBatchId, dispatchId } = await fixture();
        const response = await http().post(api(`/route-batches/${routeBatchId}/approve-promises`))
            .set(auth(otherReviewerToken)).send({ version: 0, dispatches: [{ dispatchId, version: 0 }] });
        expect(response.status).toBe(403);
        expect(response.body.error).toBe('ROUTE_BATCH_REVIEWER_MISMATCH');
    });
});
