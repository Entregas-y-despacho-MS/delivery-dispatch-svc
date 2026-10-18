// ST-224.1 — Confirm and ask for a change from the tracking link, end to end (stage 3).
//
// Real AppModule and database; dispatches inserted in the state each case needs. The preparation order is read
// from the real outbox. The 12 h closing runs through the real service with a simulated clock, limited to this
// suite's dispatches, to prove it never adds a second order after the customer answered.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { PromiseWindowCandidatesRepository } from '../src/app/promise-firming/services/promise-window-candidates.repository.js';
import { PromiseWindowCloseService } from '../src/app/promise-firming/services/promise-window-close.service.js';
import { TrackedFixtures } from './helpers/tracked-dispatch.fixtures.js';

const MIN = 60_000;
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

describe('Confirm and change request by token (e2e, ST-224.1)', () => {
    let app: INestApplication;
    let db: DataSource;
    let fixtures: TrackedFixtures;
    let close: PromiseWindowCloseService;
    let prefix: string;
    const scope = new Set<number>();

    const run = Date.now().toString(36).toUpperCase();
    const http = () => request(app.getHttpServer());
    const base = (token: string) => `/${prefix}/public/tracking/${token}`;
    const confirm = (token: string) => http().post(`${base(token)}/confirm`);
    const ask = (token: string, body: unknown) => http().post(`${base(token)}/change-request`).send(body as object);

    // The closing task only looks at what this suite created.
    class ScopedCandidates extends PromiseWindowCandidatesRepository {
        async findClosable(now: Date, windowMinutes: number, limit?: number) {
            return (await super.findClosable(now, windowMinutes, limit)).filter((id) => scope.has(id));
        }
    }

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
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
        fixtures = new TrackedFixtures(db, `E2EPUBRSP-${run}`);
    });

    afterAll(async () => {
        if (db) await fixtures.cleanup();
        await app?.close();
    });

    async function create(options: Parameters<TrackedFixtures['create']>[0] = {}) {
        const created = await fixtures.create(options);
        scope.add(created.dispatchId);
        return created;
    }

    const row = async (dispatchId: number) => (await db.query(
        `SELECT s.name AS status, d.version, d.customer_confirmation, d.promise_notified_at, d.promise_firmed_at
           FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id) WHERE d.dispatch_id = $1`, [dispatchId]))[0];
    const orders = async (ref: string) => await db.query(
        `SELECT payload FROM outbound_messages
          WHERE type = 'dispatch.shipment.prepare_requested' AND payload->'data'->>'salesOrderId' = $1`, [ref]);
    const events = async (dispatchId: number, type: string) => await db.query(
        `SELECT actor_type, reason, detail, metadata FROM dispatch_events WHERE dispatch_id = $1 AND event_type = $2`, [dispatchId, type]);

    describe('confirm', () => {
        it('firms the promise now, queues one preparation order and ends the self-service', async () => {
            const { token, dispatchId, ref } = await create();

            const res = await confirm(token);

            expect(res.status).toBe(200);
            expect(res.headers['cache-control']).toBe('no-store');
            expect(res.body).toMatchObject({
                customerConfirmation: 'confirmed',
                selfService: { open: false, closedReason: 'confirmed', canConfirm: false, canReschedule: false, canRequestChange: true },
            });
            const after = await row(dispatchId);
            expect(after).toMatchObject({ customer_confirmation: 'confirmed', version: 1 });
            expect(after.promise_firmed_at).not.toBeNull();
            const queued = await orders(ref);
            expect(queued).toHaveLength(1);
            expect(queued[0].payload.data).toMatchObject({ salesOrderId: ref, recordVersion: 1, departureDate: '2026-10-20' });
            expect(await events(dispatchId, 'promise_firmed')).toMatchObject([
                { actor_type: 'customer', metadata: { reason: 'customer_confirmed', recordVersion: 1 } },
            ]);
        });

        it('does not queue a second order when the 12 h window closes afterwards', async () => {
            const { token, dispatchId, ref } = await create();
            await confirm(token);
            const notifiedAt: Date = (await row(dispatchId)).promise_notified_at;

            await close.run(new Date(notifiedAt.getTime() + 725 * MIN));

            expect(await orders(ref)).toHaveLength(1);
            expect(await events(dispatchId, 'promise_firmed')).toHaveLength(1);
        });

        it('queues exactly one order when the customer clicks twice at once', async () => {
            const { token, ref } = await create();

            const results = await Promise.all([confirm(token), confirm(token), confirm(token)]);

            expect(results.map((r) => r.status).filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
            for (const res of results) expect([200, 409]).toContain(res.status);
            expect(await orders(ref)).toHaveLength(1);
        });

        it('is a 409 the second time, with its reason', async () => {
            const { token } = await create();
            await confirm(token);

            const again = await confirm(token);

            expect(again.status).toBe(409);
            expect(again.body).toMatchObject({ error: 'CONFIRMATION_NOT_AVAILABLE', details: { reason: 'confirmed' } });
        });

        it('cannot confirm after the window, with a bounced notice, or on a delivery that is already moving', async () => {
            const late = await create({ notifiedAt: new Date(Date.now() - 721 * MIN) });
            const bounced = await create({ notifiedAt: null });
            const moving = await create({ status: 'out_for_delivery' });

            expect((await confirm(late.token)).body.details).toEqual({ reason: 'window_elapsed' });
            expect((await confirm(bounced.token)).body.details).toEqual({ reason: 'no_valid_notice' });
            expect((await confirm(moving.token)).body.details).toEqual({ reason: 'not_open' });
            for (const { dispatchId, ref } of [late, bounced, moving]) {
                expect((await row(dispatchId)).promise_firmed_at).toBeNull();
                expect(await orders(ref)).toHaveLength(0);
            }
        });

        it('does not firm a promise whose order cannot be built, and says so', async () => {
            const { token, dispatchId, ref } = await create({ packages: false });

            const res = await confirm(token);

            expect(res.status).toBe(409);
            expect(res.body.details).toEqual({ reason: 'order_incomplete' });
            expect((await row(dispatchId)).promise_firmed_at).toBeNull();
            expect(await orders(ref)).toHaveLength(0);
        });

        it('answers the same 404 for an unknown token', async () => {
            const res = await confirm(UNKNOWN);

            expect(res.status).toBe(404);
            expect(res.body).toMatchObject({ error: 'TRACKING_LINK_NOT_FOUND', path: `/${prefix}/public/tracking/:token/confirm` });
        });
    });

    describe('change request', () => {
        it('marks the delivery, keeps what the customer wrote and moves nothing', async () => {
            const { token, dispatchId, ref, routeBatchId } = await create();
            const before = await row(dispatchId);

            const res = await ask(token, { detail: '  I am away that week. After the 28th, please.  ' });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                customerConfirmation: 'change_requested',
                deliveryDate: '2026-10-20',
                selfService: { open: false, closedReason: 'change_requested', canConfirm: false, canReschedule: false, canRequestChange: false },
            });
            const after = await row(dispatchId);
            expect(after).toMatchObject({ customer_confirmation: 'change_requested', version: before.version, status: 'scheduled' });
            expect(after.promise_notified_at).toEqual(before.promise_notified_at);
            expect(after.promise_firmed_at).toBeNull();
            const [{ route_batch_id }] = await db.query(`SELECT route_batch_id FROM dispatches WHERE dispatch_id = $1`, [dispatchId]);
            expect(Number(route_batch_id)).toBe(routeBatchId);
            expect(await orders(ref)).toHaveLength(0);

            const [event] = await events(dispatchId, 'change_requested');
            expect(event).toMatchObject({
                actor_type: 'customer',
                detail: 'I am away that week. After the 28th, please.',
                metadata: { previousCustomerConfirmation: 'pending', selfServiceOpen: true, status: 'scheduled' },
            });
        });

        it('works after the window, which is the only thing the customer can do then', async () => {
            const { token, dispatchId } = await create({ notifiedAt: new Date(Date.now() - 800 * MIN) });

            const res = await ask(token, { detail: 'Please move it to the afternoon.' });

            expect(res.status).toBe(200);
            const [event] = await events(dispatchId, 'change_requested');
            expect(event.metadata).toMatchObject({ selfServiceOpen: false, selfServiceClosedReason: 'window_elapsed' });
        });

        it('keeps a firm promise firm and does not queue another order', async () => {
            const { token, dispatchId, ref } = await create();
            await confirm(token);
            const firmedAt = (await row(dispatchId)).promise_firmed_at;

            const res = await ask(token, { detail: 'I changed my mind.' });

            expect(res.status).toBe(200);
            expect(await row(dispatchId)).toMatchObject({ customer_confirmation: 'change_requested', promise_firmed_at: firmedAt });
            expect(await orders(ref)).toHaveLength(1);
        });

        it('stops the 12 h timer from firming a promise whose customer asked for a change', async () => {
            const { token, dispatchId, ref } = await create();
            await ask(token, { detail: 'Not that day.' });
            const notifiedAt: Date = (await row(dispatchId)).promise_notified_at;

            await close.run(new Date(notifiedAt.getTime() + 725 * MIN));

            expect((await row(dispatchId)).promise_firmed_at).toBeNull();
            expect(await orders(ref)).toHaveLength(0);
        });

        it('records a single request when two arrive at once', async () => {
            const { token, dispatchId } = await create();

            const results = await Promise.all([ask(token, { detail: 'one' }), ask(token, { detail: 'two' })]);

            expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
            expect(await events(dispatchId, 'change_requested')).toHaveLength(1);
        });

        it('is a 409 the second time and for a delivery that is already on the road', async () => {
            const { token } = await create();
            await ask(token, { detail: 'once' });
            const moving = await create({ status: 'out_for_delivery' });

            expect((await ask(token, { detail: 'twice' })).body).toMatchObject({ error: 'CHANGE_REQUEST_NOT_AVAILABLE', details: { reason: 'change_requested' } });
            expect((await ask(moving.token, { detail: 'x' })).body.details).toEqual({ reason: 'not_open' });
        });

        it('rejects a missing, empty, blank, too long or non-text detail', async () => {
            const { token, dispatchId } = await create();

            for (const body of [{}, { detail: '' }, { detail: '   ' }, { detail: 'x'.repeat(501) }, { detail: 42 }, { detail: null }, { detail: 'ok', extra: 1 }]) {
                const res = await ask(token, body);
                expect(res.status).toBe(400);
                expect(res.body.error).toBe('Bad Request');
            }
            expect((await row(dispatchId)).customer_confirmation).toBe('pending');
            expect((await ask(token, { detail: 'x'.repeat(500) })).status).toBe(200);
        });

        it('answers the same 404 for an unknown token', async () => {
            const res = await ask(UNKNOWN, { detail: 'x' });

            expect(res.status).toBe(404);
            expect(res.body).toMatchObject({ error: 'TRACKING_LINK_NOT_FOUND', path: `/${prefix}/public/tracking/:token/change-request` });
        });
    });
});
