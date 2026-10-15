// ST-215.4 — Cierre de las 12 h, firmeza de la promesa y orden de preparación, de punta a punta.
//
// Levanta el AppModule real contra una base de datos real. La 1.ª aprobación (ST-215.2) es la real y deja
// `promise_notified_at` solo si el correo se acepta; el correo se simula (un destinatario concreto rebota).
// El cierre de la ventana lo ejecuta el servicio real con un reloj simulado, y la lectura de candidatos se
// acota a los despachos de esta corrida para no firmar datos de otros suites. Todo lleva un prefijo único y
// se borra en afterAll.
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
import { PromiseFirmingService } from '../src/app/promise-firming/services/promise-firming.service.js';
import { PromiseWindowCandidatesRepository } from '../src/app/promise-firming/services/promise-window-candidates.repository.js';
import { PromiseWindowCloseService } from '../src/app/promise-firming/services/promise-window-close.service.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

const BOUNCING_EMAIL = 'bounce@example.test';
const MIN = 60_000;

describe('Promise firming (e2e, ST-215.4)', () => {
    let app: INestApplication;
    let db: DataSource;
    let prefix: string;
    let reviewerToken: string;
    let reviewerId = 0;
    let warehouse = { id: 0, code: '' };
    let close: PromiseWindowCloseService;
    let firming: PromiseFirmingService;

    const run = Date.now().toString(36).toUpperCase();
    const tag = `E2EFIRM-${run}`;
    const scope = { dispatchIds: new Set<number>() };
    const batchIds: number[] = [];
    const vehicleIds: number[] = [];
    const refs: string[] = [];
    let seq = 0;

    // Candidates are limited to what this suite created.
    class ScopedCandidates extends PromiseWindowCandidatesRepository {
        async findClosable(now: Date, windowMinutes: number, limit?: number) {
            return (await super.findClosable(now, windowMinutes, limit)).filter((id) => scope.dispatchIds.has(id));
        }
    }

    const http = () => request(app.getHttpServer());
    const api = (path: string) => `/${prefix}${path}`;

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(MailerPort)
            .useValue({
                send: async (options: { to: string | string[] }) => {
                    const to = Array.isArray(options.to) ? options.to : [options.to];
                    return { status: to.includes(BOUNCING_EMAIL) ? 'bounced' : 'sent' };
                },
            })
            .overrideProvider(PromiseWindowCandidatesRepository)
            .useFactory({ factory: (ds: DataSource) => new ScopedCandidates(ds), inject: [DataSource] })
            .compile();
        app = moduleRef.createNestApplication();
        prefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(prefix);
        app.useGlobalPipes(new ValidationPipe({
            transform: true, whitelist: true, forbidNonWhitelisted: true,
            transformOptions: { enableImplicitConversion: false },
        }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        db = moduleRef.get(DataSource);
        close = moduleRef.get(PromiseWindowCloseService);
        firming = moduleRef.get(PromiseFirmingService);

        const [{ role_id }] = await db.query(`SELECT role_id FROM roles WHERE name = 'coordinator'`);
        const [user] = await db.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, active, requires_pwd_change)
             VALUES ($1, $2, $3, $4, TRUE, FALSE) RETURNING user_id, username`,
            [role_id, `Firming ${run}`, `e2e_firming_${run}`, await hashPassword('E2eTest1234')],
        );
        reviewerId = user.user_id;
        reviewerToken = (await http().post(api('/auth/login')).send({ username: user.username, password: 'E2eTest1234' })).body.accessToken;

        const [wh] = await db.query(`SELECT warehouse_id, code FROM warehouses WHERE active = TRUE ORDER BY warehouse_id LIMIT 1`);
        warehouse = { id: wh.warehouse_id, code: wh.code };
    });

    afterAll(async () => {
        if (db) {
            await withEventPurge(db, { dispatchRefs: refs.map((ref) => `${ref}%`), routeBatchIds: batchIds }, async (manager) => {
                await manager.query(`DELETE FROM outbound_messages WHERE payload->'data'->>'salesOrderId' LIKE $1`, [`${tag}%`]);
                await manager.query(`DELETE FROM dispatch_packages WHERE dispatch_id = ANY($1::int[])`, [[...scope.dispatchIds]]);
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref = ANY($1::text[])`, [refs]);
                await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
                await manager.query(`DELETE FROM vehicles WHERE vehicle_id = ANY($1::int[])`, [vehicleIds]);
                await manager.query(`DELETE FROM users WHERE user_id = $1`, [reviewerId]);
            });
        }
        await app?.close();
    });

    /** A provisional batch with one dispatch, approved through the real endpoint (ST-215.2). */
    async function approvedDispatch(email: string = 'customer@example.test') {
        const [{ vehicle_status_id }] = await db.query(`SELECT vehicle_status_id FROM vehicle_statuses WHERE name = 'active'`);
        const [{ dispatch_type_id }] = await db.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);
        const [{ dispatch_status_id }] = await db.query(`SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'in_planning'`);
        const [{ vehicle_id }] = await db.query(
            `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3)
             VALUES ($1, 'van', 'E2E firming', $2, 100, 10) RETURNING vehicle_id`,
            [vehicle_status_id, `F${run.slice(-5)}${vehicleIds.length}`],
        );
        vehicleIds.push(vehicle_id);
        const [{ route_batch_id }] = await db.query(
            `INSERT INTO route_batches (status, reviewer_user_id, vehicle_id, shift_date)
             VALUES ('provisional', $1, $2, '2026-10-20') RETURNING route_batch_id`,
            [reviewerId, vehicle_id],
        );
        batchIds.push(route_batch_id);
        const ref = `${tag}-${++seq}`;
        refs.push(ref);
        const [{ dispatch_id }] = await db.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order, source_order_ref,
                    delivery_address, contact_name, contact_email, estimated_weight_kg, origin_warehouse_id, tracking_code,
                    scheduled_window_start, scheduled_window_end)
             VALUES ($1, $2, $3, 1, $4, 'Test address', 'E2E customer', $5, 1, $6, next_tracking_code(),
                     '2026-10-20T13:00:00Z', '2026-10-20T15:00:00Z') RETURNING dispatch_id`,
            [dispatch_type_id, dispatch_status_id, route_batch_id, ref, email, warehouse.id],
        );
        scope.dispatchIds.add(dispatch_id);
        await db.query(
            `INSERT INTO dispatch_packages (dispatch_id, external_package_id, length_cm, width_cm, height_cm, gross_weight_kg)
             VALUES ($1, $2, 40, 30, 25, 6.4)`,
            [dispatch_id, `${ref}-PKG-1`],
        );
        const approval = await http().post(api(`/route-batches/${route_batch_id}/approve-promises`))
            .set({ Authorization: `Bearer ${reviewerToken}` })
            .send({ version: 0, dispatches: [{ dispatchId: dispatch_id, version: 0 }] });
        expect(approval.status).toBe(200);
        return { dispatchId: Number(dispatch_id), ref, routeBatchId: Number(route_batch_id) };
    }

    const row = async (dispatchId: number) => (await db.query(
        `SELECT s.name AS status, d.version, d.customer_confirmation, d.promise_notified_at, d.promise_firmed_at
           FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id) WHERE d.dispatch_id = $1`, [dispatchId]))[0];
    const orders = async (ref: string) => await db.query(
        `SELECT payload FROM outbound_messages
          WHERE type = 'dispatch.shipment.prepare_requested' AND payload->'data'->>'salesOrderId' = $1
          ORDER BY (payload->'data'->>'recordVersion')::int`, [ref]);
    const events = async (dispatchId: number, type: string) => await db.query(
        `SELECT actor_type, metadata FROM dispatch_events WHERE dispatch_id = $1 AND event_type = $2`, [dispatchId, type]);
    const afterNotice = async (dispatchId: number, minutes: number) =>
        new Date((await row(dispatchId)).promise_notified_at.getTime() + minutes * MIN);

    it('firms in silence exactly when the 12 h elapse and queues one contract-valid order, once', async () => {
        const { dispatchId, ref } = await approvedDispatch();
        expect(await row(dispatchId)).toMatchObject({ status: 'scheduled', version: 1, customer_confirmation: 'pending', promise_firmed_at: null });

        await close.run(await afterNotice(dispatchId, 719));
        expect((await row(dispatchId)).promise_firmed_at).toBeNull();
        expect(await orders(ref)).toHaveLength(0);

        // Postgres keeps microseconds and a JS Date milliseconds: a closing at exactly +720 min may fall a few
        // microseconds short in SQL and is picked up by the next 5-minute tick, so the test uses +720 min 1 s.
        const closing = new Date((await afterNotice(dispatchId, 720)).getTime() + 1000);
        const summary = await close.run(closing);
        expect(summary.firmed).toBeGreaterThanOrEqual(1);
        expect(await row(dispatchId)).toMatchObject({ customer_confirmation: 'confirmed' });
        expect((await row(dispatchId)).promise_firmed_at).toEqual(closing);

        const queued = await orders(ref);
        expect(queued).toHaveLength(1);
        expect(queued[0].payload.data).toMatchObject({
            salesOrderId: ref, recordVersion: 1, warehouseId: warehouse.code, departureDate: '2026-10-20',
            deliveryWindowStart: '2026-10-20T13:00:00.000Z', deliveryWindowEnd: '2026-10-20T15:00:00.000Z',
            packages: [{ packageId: `${ref}-PKG-1`, lengthCm: 40, widthCm: 30, heightCm: 25, grossWeightKg: 6.4 }],
        });
        const [event] = await events(dispatchId, 'promise_firmed');
        expect(event).toMatchObject({ actor_type: 'system', metadata: { reason: 'window_elapsed', recordVersion: 1 } });

        // Re-running the same closing (or the next tick) does not emit again.
        await close.run(closing);
        await close.run(await afterNotice(dispatchId, 725));
        expect(await orders(ref)).toHaveLength(1);
    });

    it('does not firm a bounced notice by silence: the clock never started', async () => {
        const { dispatchId, ref } = await approvedDispatch(BOUNCING_EMAIL);

        const after = await row(dispatchId);
        expect(after).toMatchObject({ status: 'scheduled', promise_notified_at: null });

        await close.run(new Date(Date.now() + 48 * 60 * MIN));
        expect(await row(dispatchId)).toMatchObject({ promise_firmed_at: null, customer_confirmation: 'pending' });
        expect(await orders(ref)).toHaveLength(0);
        // The explicit confirmation does not firm it either: there is no valid notice to confirm.
        expect(await firming.firm(dispatchId, { reason: 'customer_confirmed' }))
            .toEqual({ outcome: 'not_eligible', dispatchId, cause: 'no_valid_notice' });
    });

    it('firms immediately on an explicit confirmation and the later window close adds nothing', async () => {
        const { dispatchId, ref } = await approvedDispatch();
        const confirmedAt = await afterNotice(dispatchId, 30);

        const result = await firming.firm(dispatchId, { reason: 'customer_confirmed', now: confirmedAt });

        expect(result).toMatchObject({ outcome: 'firmed', reason: 'customer_confirmed', recordVersion: 1 });
        expect((await row(dispatchId)).promise_firmed_at).toEqual(confirmedAt);
        expect((await events(dispatchId, 'promise_firmed'))[0]).toMatchObject({ actor_type: 'customer' });

        await close.run(await afterNotice(dispatchId, 720));
        expect(await orders(ref)).toHaveLength(1);
    });

    it('emits exactly one order when the timer and the customer race', async () => {
        const { dispatchId, ref } = await approvedDispatch();
        const now = await afterNotice(dispatchId, 721);

        const results = await Promise.all([
            firming.firm(dispatchId, { reason: 'window_elapsed', now }),
            firming.firm(dispatchId, { reason: 'customer_confirmed', now }),
            firming.firm(dispatchId, { reason: 'window_elapsed', now }),
        ]);

        expect(results.filter((r) => r.outcome === 'firmed')).toHaveLength(1);
        expect(await orders(ref)).toHaveLength(1);
        expect(await events(dispatchId, 'promise_firmed')).toHaveLength(1);
    });

    it('replaces the order with a higher recordVersion when the customer reschedules, keeping the clock', async () => {
        const { dispatchId, ref } = await approvedDispatch();
        const notifiedAt = (await row(dispatchId)).promise_notified_at;
        await firming.firm(dispatchId, { reason: 'window_elapsed', now: await afterNotice(dispatchId, 720) });

        // Same version again: refused, nothing is sent.
        expect(await firming.reissue(dispatchId)).toMatchObject({ outcome: 'not_eligible', cause: 'version_not_increased' });

        // The rescheduling (ST-N3.1) moves the dispatch and bumps the version in its own transaction.
        await db.transaction(async (manager) => {
            await manager.query(`UPDATE dispatches SET version = version + 1 WHERE dispatch_id = $1`, [dispatchId]);
            const result = await firming.reissue(dispatchId, { manager });
            expect(result).toEqual({ outcome: 'reissued', dispatchId, recordVersion: 2 });
        });

        const queued = await orders(ref);
        expect(queued.map((q) => q.payload.data.recordVersion)).toEqual([1, 2]);
        expect(queued[1].payload.messageId).not.toBe(queued[0].payload.messageId);
        expect((await events(dispatchId, 'preparation_order_reissued'))[0].metadata).toEqual({ recordVersion: 2 });
        const after = await row(dispatchId);
        expect(after.promise_notified_at).toEqual(notifiedAt);
        expect(after.customer_confirmation).toBe('confirmed');
    });

    it('rolls the order back with the transaction that carried it', async () => {
        const { dispatchId, ref } = await approvedDispatch();

        await expect(db.transaction(async (manager) => {
            const result = await firming.firm(dispatchId, { reason: 'customer_confirmed', manager });
            expect(result.outcome).toBe('firmed');
            throw new Error('the caller failed after firming');
        })).rejects.toThrow('the caller failed');

        expect((await row(dispatchId)).promise_firmed_at).toBeNull();
        expect(await orders(ref)).toHaveLength(0);
        expect(await events(dispatchId, 'promise_firmed')).toHaveLength(0);
    });
});
