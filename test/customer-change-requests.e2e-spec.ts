// ST-224.1 (extension for ES-227) — the coordinator's tray of change requests left by customers (stage 1: the list).
//
// Real AppModule and database. Requests are inserted in the exact state each case needs, always inside a zone of the
// suite so the list can be narrowed to it; everything carries a per-run tag and is removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { TrackedFixtures, type TrackedDispatch } from './helpers/tracked-dispatch.fixtures.js';

const MIN = 60_000;

describe('Customer change requests list (e2e, ST-224.1 extension)', () => {
    let app: INestApplication;
    let db: DataSource;
    let fixtures: TrackedFixtures;
    let prefix: string;
    let zoneId = 0;
    let otherZoneId = 0;
    let warehouseId = 0;
    const tokens: Record<string, string> = {};

    const run = Date.now().toString(36).toUpperCase();
    const http = () => request(app.getHttpServer());
    const list = (role: string, qs = '') => http().get(`/${prefix}/dispatches/change-requests?${qs}`).set({ Authorization: `Bearer ${tokens[role]}` });
    const inZone = (qs = '') => `delivery_zone_id=${zoneId}${qs ? `&${qs}` : ''}`;

    /** A delivery with a change request, inserted the way the public page leaves it. */
    async function requested(options: {
        email?: string | null; text?: string | null; name?: string; at?: Date; tokenExpiresAt?: Date | null; status?: string;
        confirmation?: string; zone?: number; shiftDate?: string; firmed?: boolean; metadata?: Record<string, unknown>; events?: number;
    } = {}): Promise<TrackedDispatch> {
        const zone = options.zone ?? zoneId;
        const batchId = await fixtures.createBatch({ shiftDate: options.shiftDate ?? '2026-10-21', vehicleId: await fixtures.createVehicle(), zoneId: zone, warehouseId });
        const created = await fixtures.create({
            routeBatchId: batchId, zoneId: zone, warehouseId, km: 1, email: options.email,
            status: options.status ?? 'scheduled', customerConfirmation: options.confirmation ?? 'change_requested',
            tokenExpiresAt: options.tokenExpiresAt,
        });
        await db.query(`UPDATE dispatches SET contact_name = $2, promise_firmed_at = $3 WHERE dispatch_id = $1`,
            [created.dispatchId, options.name ?? 'E2E customer', options.firmed ? new Date() : null]);
        for (let i = 0; i < (options.events ?? 1); i++) {
            await db.query(
                `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, reason, detail, metadata, created_at)
                 VALUES ($1, 'change_requested', 'customer', 'Customer asked for a change from the tracking link', $2, $3::jsonb, $4)`,
                [
                    created.dispatchId,
                    options.text === undefined ? `Please move it (${created.ref}) #${i + 1}` : options.text,
                    JSON.stringify(options.metadata ?? { previousCustomerConfirmation: 'pending', selfServiceOpen: true, selfServiceClosedReason: null, status: 'scheduled' }),
                    new Date((options.at ?? new Date()).getTime() + i * 1000),
                ],
            );
        }
        return created;
    }

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
        fixtures = new TrackedFixtures(db, `E2ECHGREQ-${run}`);

        const passwordHash = await hashPassword('E2eTest1234');
        for (const role of ['coordinator', 'supervisor', 'admin', 'driver']) {
            const [{ role_id }] = await db.query(`SELECT role_id FROM roles WHERE name = $1`, [role]);
            const username = `e2e_chgreq_${role}_${run}`;
            await db.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false)`,
                [role_id, `Change requests ${role} ${run}`, username, passwordHash],
            );
            const res = await http().post(`/${prefix}/auth/login`).send({ username, password: 'E2eTest1234' });
            tokens[role] = res.body.accessToken as string;
        }

        warehouseId = (await fixtures.warehouses())[0].id;
        zoneId = await fixtures.createZone('A');
        otherZoneId = await fixtures.createZone('B');
    });

    afterAll(async () => {
        if (db) {
            await fixtures.cleanup();
            await db.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_chgreq_%_${run}`]);
        }
        await app?.close();
    });

    describe('who can read it', () => {
        it('needs a token, and only the coordinator and the supervisor may read it', async () => {
            expect((await http().get(`/${prefix}/dispatches/change-requests`)).status).toBe(401);
            expect((await list('admin', inZone())).status).toBe(403);
            expect((await list('driver', inZone())).status).toBe(403);
            expect((await list('coordinator', inZone())).status).toBe(200);
            expect((await list('supervisor', inZone())).status).toBe(200);
        });
    });

    describe('what it lists', () => {
        it('lists the pending requests, the oldest first, with what the customer asked and where the delivery is', async () => {
            const older = await requested({ text: 'After the 28th, please.', at: new Date(Date.now() - 90 * MIN), name: 'Ana Perez', email: null });
            const newer = await requested({ text: 'Not that day.', at: new Date(Date.now() - 30 * MIN), name: 'Luis Rojas' });

            const res = await list('coordinator', inZone());

            expect(res.status).toBe(200);
            expect(res.body.meta).toEqual({ page: 1, limit: 10, total: 2, pages: 1 });
            expect(res.body.data.map((item: any) => item.dispatchId)).toEqual([older.dispatchId, newer.dispatchId]);
            expect(res.body.data[0]).toMatchObject({
                dispatchId: older.dispatchId,
                trackingCode: older.trackingCode,
                status: 'scheduled',
                routeBatchId: older.routeBatchId,
                deliveryDate: '2026-10-21',
                zoneId,
                contactName: 'Ana Perez',
                hasContactEmail: false,
                request: { detail: 'After the 28th, please.', responseWindowWasOpen: true, selfServiceClosedReason: null },
                promiseIsFirm: false,
                promiseFirmedAt: null,
            });
            expect(new Date(res.body.data[0].request.requestedAt).getTime()).toBeLessThan(new Date(res.body.data[1].request.requestedAt).getTime());
        });

        it('says when the promise is already firm and why the self-service was over when the customer asked', async () => {
            const late = await requested({
                firmed: true, text: 'Too late for me.',
                metadata: { previousCustomerConfirmation: 'confirmed', selfServiceOpen: false, selfServiceClosedReason: 'window_elapsed', status: 'scheduled' },
            });

            const item = (await list('coordinator', inZone(`search=${late.trackingCode}`))).body.data[0];

            expect(item.promiseIsFirm).toBe(true);
            expect(new Date(item.promiseFirmedAt).getTime()).toBeGreaterThan(0);
            expect(item.request).toMatchObject({ responseWindowWasOpen: false, selfServiceClosedReason: 'window_elapsed' });
        });

        it('uses the last request when the customer asked more than once, and a request without text is still listed', async () => {
            const many = await requested({ events: 3 });
            const silent = await requested({ text: null });

            const items = (await list('coordinator', inZone(`search=${many.trackingCode}`))).body.data;
            const withoutText = (await list('coordinator', inZone(`search=${silent.trackingCode}`))).body.data;

            expect(items).toHaveLength(1);
            expect(items[0].request.detail).toBe(`Please move it (${many.ref}) #3`);
            expect(withoutText[0].request.detail).toBeNull();
        });

        it('leaves out what is not a pending request: answered, resolved, or already on the road', async () => {
            const pending = await requested();
            const confirmed = await requested({ confirmation: 'confirmed' });
            const resolved = await requested({ confirmation: 'rescheduled' });
            const onTheRoad = await requested({ status: 'out_for_delivery' });
            const delivered = await requested({ status: 'delivered' });
            const assigned = await requested({ status: 'assigned' });

            const ids = (await list('coordinator', inZone('limit=100'))).body.data.map((item: any) => item.dispatchId);

            expect(ids).toContain(pending.dispatchId);
            expect(ids).toContain(assigned.dispatchId);
            for (const excluded of [confirmed, resolved, onTheRoad, delivered]) expect(ids).not.toContain(excluded.dispatchId);
        });

        it('takes a request out of the list when the coordinator resolves it', async () => {
            const request1 = await requested();
            expect((await list('coordinator', inZone(`search=${request1.trackingCode}`))).body.data).toHaveLength(1);

            await db.query(`UPDATE dispatches SET customer_confirmation = 'rescheduled' WHERE dispatch_id = $1`, [request1.dispatchId]);

            expect((await list('coordinator', inZone(`search=${request1.trackingCode}`))).body.data).toHaveLength(0);
        });
    });

    describe('the tracking link', () => {
        it('is offered only to the coordinator, for a customer without email and with a working token', async () => {
            const withoutEmail = await requested({ email: null });
            const withEmail = await requested({ email: 'customer@example.test' });
            const expired = await requested({ email: null, tokenExpiresAt: new Date(Date.now() - MIN) });
            const flag = async (role: string, target: TrackedDispatch) =>
                (await list(role, inZone(`search=${target.trackingCode}`))).body.data[0].canRevealTrackingLink;

            expect(await flag('coordinator', withoutEmail)).toBe(true);
            expect(await flag('coordinator', withEmail)).toBe(false);
            expect(await flag('coordinator', expired)).toBe(false);
            expect(await flag('supervisor', withoutEmail)).toBe(false);
        });

        it('never travels in the list: no token, link, email, phone or address in any answer', async () => {
            const withoutEmail = await requested({ email: null });
            const withEmail = await requested({ email: 'customer@example.test' });

            const bodies = JSON.stringify([
                (await list('coordinator', inZone('limit=100'))).body,
                (await list('supervisor', inZone('limit=100'))).body,
            ]);

            for (const secret of [withoutEmail.token, withEmail.token, 'customer@example.test', '70000000', 'Calle Secreta']) {
                expect(bodies).not.toContain(secret);
            }
            expect(bodies).not.toMatch(/seguimiento\/|trackingUrl|tracking_token|trackingToken/);
        });
    });

    describe('filters and pages', () => {
        it('narrows by zone and by the date of the route', async () => {
            const inOther = await requested({ zone: otherZoneId, shiftDate: '2026-11-02' });
            const onDate = await requested({ shiftDate: '2026-11-03' });

            const byZone = (await list('coordinator', `delivery_zone_id=${otherZoneId}`)).body.data.map((item: any) => item.dispatchId);
            const byDate = (await list('coordinator', inZone('date=2026-11-03'))).body.data.map((item: any) => item.dispatchId);

            expect(byZone).toEqual([inOther.dispatchId]);
            expect(byDate).toEqual([onDate.dispatchId]);
            expect((await list('coordinator', inZone('date=2031-01-01'))).body).toEqual({ data: [], meta: { page: 1, limit: 10, total: 0, pages: 0 } });
        });

        it('searches the tracking code and the name of the contact, matching % and _ literally', async () => {
            const maria = await requested({ name: `Maria 50%_off ${run}` });
            await requested({ name: `Maria 500 ${run}` });

            const byName = (await list('coordinator', inZone(`search=${encodeURIComponent('50%_off')}`))).body.data.map((item: any) => item.dispatchId);
            const byCode = (await list('coordinator', inZone(`search=${maria.trackingCode.toLowerCase()}`))).body.data.map((item: any) => item.dispatchId);

            expect(byName).toEqual([maria.dispatchId]);
            expect(byCode).toEqual([maria.dispatchId]);
        });

        it('pages the list and counts every match', async () => {
            const pagedZone = await fixtures.createZone('P');
            const ids: number[] = [];
            for (let i = 0; i < 5; i++) ids.push((await requested({ zone: pagedZone, at: new Date(Date.now() - (50 - i) * MIN) })).dispatchId);

            const first = (await list('coordinator', `delivery_zone_id=${pagedZone}&limit=2&page=1`)).body;
            const last = (await list('coordinator', `delivery_zone_id=${pagedZone}&limit=2&page=3`)).body;

            expect(first.meta).toEqual({ page: 1, limit: 2, total: 5, pages: 3 });
            expect(first.data.map((item: any) => item.dispatchId)).toEqual(ids.slice(0, 2));
            expect(last.data.map((item: any) => item.dispatchId)).toEqual(ids.slice(4));
        });

        it('rejects a page, limit, zone, date or search that is not valid', async () => {
            for (const bad of ['page=0', 'limit=0', 'limit=101', 'delivery_zone_id=abc', 'delivery_zone_id=0', 'date=2026-13-45', 'date=21-10-2026', `search=${'x'.repeat(101)}`, 'unknown=1']) {
                const res = await list('coordinator', bad);
                expect(res.status, bad).toBe(400);
                expect(res.body.error).toBe('Bad Request');
            }
        });
    });
});
