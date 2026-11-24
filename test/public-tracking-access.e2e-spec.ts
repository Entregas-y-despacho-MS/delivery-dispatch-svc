// ST-309.1 — Access to the tracking page by tracking code plus a one-time code, end to end.
//
// Real AppModule, real database and the in-memory cache of the e2e config. The mailer is replaced by one that keeps
// what it was asked to send, which is how the suite reads the code the customer would receive. Every test uses its own
// dispatch, because the limits are counted per tracking code. Only `Date` is faked when a test needs time to pass.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { SettingsService } from '../src/modules/settings/services/settings.service.js';
import { MailerPort } from '../src/plugins/mailer/mailer.port.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { TrackingAccessService } from '../src/app/public-tracking/services/tracking-access.service.js';
import { TrackedFixtures } from './helpers/tracked-dispatch.fixtures.js';

const MIN = 60_000;
const EXPIRY_KEY = 'reschedule_code_expiry_minutes';
const GENERIC_REQUEST = { accepted: true, expiresInSeconds: 600 };

describe('Access to the tracking page by code (e2e, ST-309.1)', () => {
    let app: INestApplication;
    let db: DataSource;
    let settings: SettingsService;
    let access: TrackingAccessService;
    let fixtures: TrackedFixtures;
    let prefix: string;
    let originalExpiry = '';
    const mails: { to: string; template: string; context: { code: string } }[] = [];

    const run = Date.now().toString(36).toUpperCase();
    const http = () => request(app.getHttpServer());
    const base = () => `/${prefix}/public/tracking`;
    const askCode = (trackingCode: unknown) => http().post(`${base()}/access/code`).send({ trackingCode });
    const verify = (trackingCode: unknown, code: unknown) => http().post(`${base()}/access/verify`).send({ trackingCode, code });
    const view = (session?: string) => {
        const req = http().get(`${base()}/access/view`);
        return session === undefined ? req : req.set('X-Tracking-Session', session);
    };
    const lastCode = () => mails.at(-1)!.context.code;
    const wrongOf = (code: string) => (code === '000000' ? '111111' : '000000');

    /** Asks for the code and returns the one that was mailed. */
    async function codeFor(trackingCode: string): Promise<string> {
        const before = mails.length;
        const res = await askCode(trackingCode);
        expect(res.status).toBe(200);
        await access.whenIdle();
        expect(mails.length).toBe(before + 1);
        return lastCode();
    }

    async function sessionFor(trackingCode: string): Promise<string> {
        const res = await verify(trackingCode, await codeFor(trackingCode));
        expect(res.status).toBe(200);
        return res.body.session;
    }

    const events = async (dispatchId: number) => await db.query(
        `SELECT event_type, actor_type, reason, metadata FROM dispatch_events WHERE dispatch_id = $1 AND event_type LIKE 'tracking_access_%' ORDER BY dispatch_event_id`,
        [dispatchId],
    );

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(MailerPort)
            .useValue({ send: async (mail: any) => { mails.push(mail); return { status: 'sent' }; } })
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
        settings = moduleRef.get(SettingsService);
        access = moduleRef.get(TrackingAccessService);
        fixtures = new TrackedFixtures(db, `E2EPUBACC-${run}`);

        const [row] = await db.query(`SELECT setting_value FROM settings WHERE setting_key = $1`, [EXPIRY_KEY]);
        originalExpiry = row?.setting_value ?? '';
        await db.query(`UPDATE settings SET setting_value = '10', updated_at = NOW() WHERE setting_key = $1`, [EXPIRY_KEY]);
        await settings.refresh();
    });

    afterEach(() => vi.useRealTimers());

    afterAll(async () => {
        if (db) {
            await db.query(`UPDATE settings SET setting_value = $2, updated_at = NOW() WHERE setting_key = $1`, [EXPIRY_KEY, originalExpiry]);
            await settings.refresh();
            await fixtures.cleanup();
        }
        await app?.close();
    });

    it('opens a session with the tracking code and the mailed code, and shows only the public fields', async () => {
        const { trackingCode, dispatchId } = await fixtures.create();

        const asked = await askCode(trackingCode);
        expect(asked.status).toBe(200);
        expect(asked.headers['cache-control']).toBe('no-store');
        expect(asked.body).toEqual(GENERIC_REQUEST);
        await access.whenIdle();
        expect(mails.at(-1)).toMatchObject({ to: 'customer@example.test', template: 'tracking-access-code' });
        expect(lastCode()).toMatch(/^\d{6}$/);
        expect(JSON.stringify(asked.body)).not.toContain(lastCode());

        const verified = await verify(trackingCode, lastCode());
        expect(verified.status).toBe(200);
        expect(verified.headers['cache-control']).toBe('no-store');
        expect(verified.body.session).toMatch(/^[0-9a-f]{64}$/);
        expect(new Date(verified.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 9 * MIN);

        const page = await view(verified.body.session);
        expect(page.status).toBe(200);
        expect(page.headers['cache-control']).toBe('no-store');
        expect(page.body).toMatchObject({ trackingCode, status: 'scheduled', eta: null, driver: null, location: null });
        expect(Object.keys(page.body).sort()).toEqual(['deliveryDate', 'driver', 'eta', 'location', 'status', 'trackingCode', 'windowEnd', 'windowStart']);
        const shown = JSON.stringify(page.body);
        for (const secret of ['Calle Secreta', '70000000', 'customer@example.test', 'E2E customer', 'selfService', 'otp']) expect(shown).not.toContain(secret);

        const logged = await events(dispatchId);
        expect(logged.map((e: any) => e.event_type)).toEqual(['tracking_access_code_sent', 'tracking_access_verified']);
        const everything = JSON.stringify(logged);
        for (const secret of [lastCode(), verified.body.session, 'customer@example.test', trackingCode]) expect(everything).not.toContain(secret);
    });

    it('answers the same for a tracking code that exists, one that does not and one that is malformed', async () => {
        const { trackingCode } = await fixtures.create();
        const before = mails.length;

        const known = await askCode(trackingCode);
        const unknown = await askCode('DSP-2099-99999');
        const malformed = await askCode("x'; DROP TABLE dispatches; --");
        await access.whenIdle();

        for (const res of [known, unknown, malformed]) {
            expect(res.status).toBe(200);
            expect(res.body).toEqual(GENERIC_REQUEST);
            expect(Object.keys(res.headers).filter((h) => h.startsWith('x-'))).toEqual(Object.keys(known.headers).filter((h) => h.startsWith('x-')));
        }
        expect(mails.length).toBe(before + 1);
    });

    it('answers the same 400 to a wrong code whether the tracking code exists or not', async () => {
        const { trackingCode } = await fixtures.create();
        const right = await codeFor(trackingCode);

        const wrongForKnown = await verify(trackingCode, wrongOf(right));
        const wrongForUnknown = await verify('DSP-2099-99998', '123456');
        const wrongForMalformed = await verify('nothing', '123456');

        for (const res of [wrongForKnown, wrongForUnknown, wrongForMalformed]) {
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('INVALID_ACCESS_CODE');
            expect(res.body.message).toBe(wrongForKnown.body.message);
            expect(JSON.stringify(res.body)).not.toContain('attempt');
        }
    });

    it('does not send anything for a delivery without email or with an expired link, and answers the generic way', async () => {
        const noEmail = await fixtures.create({ email: null });
        const expiredLink = await fixtures.create({ tokenExpiresAt: new Date(Date.now() - MIN) });
        const before = mails.length;

        for (const { trackingCode } of [noEmail, expiredLink]) {
            const res = await askCode(trackingCode);
            expect(res.status).toBe(200);
            expect(res.body).toEqual(GENERIC_REQUEST);
        }
        await access.whenIdle();
        expect(mails.length).toBe(before);
    });

    it('uses a code only once', async () => {
        const { trackingCode } = await fixtures.create();
        const code = await codeFor(trackingCode);

        expect((await verify(trackingCode, code)).status).toBe(200);
        const again = await verify(trackingCode, code);
        expect(again.status).toBe(400);
        expect(again.body.error).toBe('INVALID_ACCESS_CODE');
    });

    it('lets only one of two simultaneous verifications with the right code open a session', async () => {
        const { trackingCode } = await fixtures.create();
        const code = await codeFor(trackingCode);

        const results = await Promise.all([verify(trackingCode, code), verify(trackingCode, code)]);

        expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    });

    it('burns the code after 5 wrong guesses and audits it', async () => {
        const { trackingCode, dispatchId } = await fixtures.create();
        const right = await codeFor(trackingCode);

        for (let i = 0; i < 5; i++) expect((await verify(trackingCode, wrongOf(right))).status).toBe(400);
        const sixth = await verify(trackingCode, wrongOf(right));
        expect(sixth.status).toBe(400);
        expect((await verify(trackingCode, right)).status).toBe(400);

        await access.whenIdle();
        const logged = await events(dispatchId);
        expect(logged.map((e: any) => e.event_type)).toContain('tracking_access_locked');
        expect(JSON.stringify(logged)).not.toContain(right);
    });

    it('blocks too many tries for a tracking code with the same 429 whether it exists or not', async () => {
        const { trackingCode } = await fixtures.create();
        const codes = [trackingCode, 'DSP-2099-99997'];

        for (const code of codes) {
            for (let i = 0; i < 10; i++) await verify(code, '123456');
            const blocked = await verify(code, '123456');
            expect(blocked.status).toBe(429);
            expect(blocked.body.error).toBe('TRACKING_ACCESS_RATE_LIMITED');
        }
    });

    it('imposes a cooldown and a limit of 3 codes per window on the request, the same for any code', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { trackingCode } = await fixtures.create();

        for (const code of [trackingCode, 'DSP-2099-99996']) {
            expect((await askCode(code)).status).toBe(200);
            const tooSoon = await askCode(code);
            expect(tooSoon.status).toBe(429);
            expect(tooSoon.body.error).toBe('TRACKING_ACCESS_RATE_LIMITED');

            vi.setSystemTime(new Date(Date.now() + 2 * MIN));
            expect((await askCode(code)).status).toBe(200);
            vi.setSystemTime(new Date(Date.now() + 2 * MIN));
            expect((await askCode(code)).status).toBe(200);
            vi.setSystemTime(new Date(Date.now() + 2 * MIN));
            const fourth = await askCode(code);
            expect(fourth.status).toBe(429);
            expect(fourth.body.error).toBe('TRACKING_ACCESS_RATE_LIMITED');
        }
    });

    it('rejects a code after it expires and a session after it expires', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { trackingCode } = await fixtures.create();
        const stale = await codeFor(trackingCode);
        vi.setSystemTime(new Date(Date.now() + 11 * MIN));
        expect((await verify(trackingCode, stale)).status).toBe(400);

        vi.setSystemTime(new Date(Date.now() + 2 * MIN));
        const session = await sessionFor(trackingCode);
        expect((await view(session)).status).toBe(200);
        vi.setSystemTime(new Date(Date.now() + 11 * MIN));
        const expired = await view(session);
        expect(expired.status).toBe(401);
        expect(expired.body.error).toBe('TRACKING_SESSION_INVALID');
    });

    it('stops showing the dispatch once its link has expired, even with a live session', async () => {
        const { trackingCode, dispatchId } = await fixtures.create();
        const session = await sessionFor(trackingCode);
        expect((await view(session)).status).toBe(200);

        await db.query(`UPDATE dispatches SET tracking_token_expires_at = NOW() - INTERVAL '1 minute' WHERE dispatch_id = $1`, [dispatchId]);

        const res = await view(session);
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('TRACKING_SESSION_INVALID');
    });

    it('limits a session to its own dispatch and never accepts the tracking code or the token as a credential', async () => {
        const a = await fixtures.create();
        const b = await fixtures.create({ status: 'assigned' });
        const sessionA = await sessionFor(a.trackingCode);
        const sessionB = await sessionFor(b.trackingCode);

        const pageA = await view(sessionA);
        const pageB = await view(sessionB);
        expect(pageA.body).toMatchObject({ trackingCode: a.trackingCode, status: 'scheduled' });
        expect(pageB.body).toMatchObject({ trackingCode: b.trackingCode, status: 'assigned' });

        // The dispatch is never taken from the request.
        const forged = await http().get(`${base()}/access/view?dispatchId=${b.dispatchId}&trackingCode=${b.trackingCode}`).set('X-Tracking-Session', sessionA);
        expect(forged.body.trackingCode).toBe(a.trackingCode);

        for (const credential of [a.trackingCode, a.token, String(a.dispatchId), '', 'a'.repeat(64)]) {
            const res = await view(credential);
            expect(res.status).toBe(401);
            expect(res.body.error).toBe('TRACKING_SESSION_INVALID');
        }
        expect((await view()).status).toBe(401);
        // As a bearer token of the other protected routes it opens nothing either.
        expect((await http().get(`/${prefix}/roles`).set('Authorization', `Bearer ${sessionA}`)).status).toBe(401);
    });

    it('keeps the link of ES-224 working and does not let the tracking code open it', async () => {
        const { token, trackingCode } = await fixtures.create();
        await sessionFor(trackingCode);

        const byLink = await http().get(`${base()}/${token}`);
        expect(byLink.status).toBe(200);
        expect(byLink.body.trackingCode).toBe(trackingCode);
        expect(byLink.body.selfService).toBeDefined();

        const byCode = await http().get(`${base()}/${trackingCode}`);
        expect(byCode.status).toBe(404);
        expect(byCode.body.error).toBe('TRACKING_LINK_NOT_FOUND');
    });

    it('does not touch the delivery OTP: no OTP event and no delivery OTP in any answer', async () => {
        const { trackingCode, dispatchId } = await fixtures.create({ status: 'in_transit' });
        const code = await codeFor(trackingCode);
        const verified = await verify(trackingCode, code);
        const page = await view(verified.body.session);

        const otpEvents = await db.query(`SELECT 1 FROM dispatch_events WHERE dispatch_id = $1 AND event_type LIKE 'otp\\_%'`, [dispatchId]);
        expect(otpEvents).toHaveLength(0);
        expect(mails.at(-1)!.template).toBe('tracking-access-code');
        for (const body of [verified.body, page.body]) expect(JSON.stringify(body)).not.toContain(code);
    });

    it('validates the body and rejects what it does not know', async () => {
        const { trackingCode } = await fixtures.create();

        expect((await askCode(undefined)).status).toBe(400);
        expect((await askCode('')).status).toBe(400);
        expect((await askCode('x'.repeat(41))).status).toBe(400);
        expect((await http().post(`${base()}/access/code`).send({ trackingCode, extra: 1 })).status).toBe(400);
        for (const code of ['12345', '1234567', 'abcdef', 123456, null]) expect((await verify(trackingCode, code)).status).toBe(400);
        expect((await http().post(`${base()}/access/verify`).send({ trackingCode, code: '123456', dispatchId: 1 })).status).toBe(400);
    });
});
