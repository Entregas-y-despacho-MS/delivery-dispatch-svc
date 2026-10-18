// ST-224.1 — Verification code of the customer's rescheduling, end to end (stage 2).
//
// Real AppModule, real database and the in-memory cache of the e2e config. The mailer is replaced by one that
// keeps what it was asked to send, so the suite can read the code the customer would receive. The two settings
// the rescheduling needs ship blank: the suite sets them and restores the originals.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { SettingsService } from '../src/modules/settings/services/settings.service.js';
import { MailerPort } from '../src/plugins/mailer/mailer.port.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { VerificationCodeService } from '../src/app/public-tracking/services/verification-code.service.js';
import { TrackedFixtures } from './helpers/tracked-dispatch.fixtures.js';

const MIN = 60_000;
const BOUNCING_EMAIL = 'bounce@example.test';
const SETTINGS_UNDER_TEST = ['warehouse_prep_lead_minutes', 'reschedule_code_expiry_minutes'];

describe('Verification code of the rescheduling (e2e, ST-224.1)', () => {
    let app: INestApplication;
    let db: DataSource;
    let settings: SettingsService;
    let verification: VerificationCodeService;
    let fixtures: TrackedFixtures;
    let prefix: string;
    const originals = new Map<string, string>();
    const mails: { to: string; template: string; context: { code: string; expiresInMinutes: number } }[] = [];

    const run = Date.now().toString(36).toUpperCase();
    const http = () => request(app.getHttpServer());
    const url = (token: string, tail = '') => `/${prefix}/public/tracking/${token}/verification-code${tail}`;
    const sendCode = (token: string) => http().post(url(token));
    const verify = (token: string, code: unknown) => http().post(url(token, '/verify')).send({ code });
    const lastCode = () => mails.at(-1)!.context.code;
    const wrongOf = (code: string) => (code === '000000' ? '111111' : '000000');

    async function setSetting(key: string, value: string) {
        await db.query(`UPDATE settings SET setting_value = $2, updated_at = NOW() WHERE setting_key = $1`, [key, value]);
        await settings.refresh();
    }

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(MailerPort)
            .useValue({
                send: async (mail: any) => {
                    mails.push(mail);
                    return { status: [mail.to].flat().includes(BOUNCING_EMAIL) ? 'bounced' : 'sent' };
                },
            })
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
        verification = moduleRef.get(VerificationCodeService);
        fixtures = new TrackedFixtures(db, `E2EPUBVER-${run}`);

        for (const key of SETTINGS_UNDER_TEST) {
            const [row] = await db.query(`SELECT setting_value FROM settings WHERE setting_key = $1`, [key]);
            originals.set(key, row?.setting_value ?? '');
        }
        await setSetting('warehouse_prep_lead_minutes', '60');
        await setSetting('reschedule_code_expiry_minutes', '10');
    });

    afterAll(async () => {
        if (db) {
            for (const [key, value] of originals) await setSetting(key, value);
            await fixtures.cleanup();
        }
        await app?.close();
    });

    const events = async (dispatchId: number) => await db.query(
        `SELECT event_type, actor_type, reason, metadata FROM dispatch_events WHERE dispatch_id = $1 AND event_type LIKE 'reschedule_code_%' ORDER BY dispatch_event_id`,
        [dispatchId],
    );

    it('mails the code to the registered email, answers a hidden address and audits it without the secret', async () => {
        const { token, dispatchId } = await fixtures.create();

        const res = await sendCode(token);

        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body.sentTo).toBe('c***@example.test');
        expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 9 * MIN);
        expect(mails.at(-1)).toMatchObject({ to: 'customer@example.test', template: 'reschedule-code' });
        expect(lastCode()).toMatch(/^\d{6}$/);
        expect(JSON.stringify(res.body)).not.toContain(lastCode());

        const logged = await events(dispatchId);
        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatchObject({ event_type: 'reschedule_code_sent', actor_type: 'customer' });
        const everything = JSON.stringify(logged);
        for (const secret of [lastCode(), token, 'customer@example.test']) expect(everything).not.toContain(secret);
    });

    it('trades the right code for a proof, and a proof is only good for that dispatch', async () => {
        const { token, dispatchId } = await fixtures.create();
        const other = await fixtures.create();
        await sendCode(token);

        const res = await verify(token, lastCode());

        expect(res.status).toBe(200);
        expect(res.body.proof).toMatch(/^[0-9a-f]{64}$/);
        expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 9 * MIN);
        await expect(verification.hasValidProof(dispatchId, res.body.proof)).resolves.toBe(true);
        await expect(verification.hasValidProof(other.dispatchId, res.body.proof)).resolves.toBe(false);
        expect((await events(dispatchId)).map((e: any) => e.event_type)).toEqual(['reschedule_code_sent', 'reschedule_code_verified']);
        expect(JSON.stringify(await events(dispatchId))).not.toContain(res.body.proof);
    });

    it('rejects a wrong code with the attempts left and a malformed one as a validation error', async () => {
        const { token } = await fixtures.create();
        await sendCode(token);

        const wrong = await verify(token, wrongOf(lastCode()));
        expect(wrong.status).toBe(400);
        expect(wrong.body).toMatchObject({ error: 'INVALID_VERIFICATION_CODE', details: { attemptsLeft: 4 } });

        for (const bad of ['12345', '1234567', 'abcdef', '12 456', 123456, null]) {
            const res = await verify(token, bad);
            expect(res.status).toBe(400);
            expect(res.body.message).toContain('code must be exactly 6 digits.');
        }
        expect((await http().post(url(token, '/verify')).send({})).status).toBe(400);
    });

    it('burns the code after 5 wrong guesses even if the next one is right, and a new code starts clean', async () => {
        const { token } = await fixtures.create();
        await sendCode(token);
        const right = lastCode();
        for (let i = 0; i < 5; i++) expect((await verify(token, wrongOf(right))).body.error).toBe('INVALID_VERIFICATION_CODE');

        const burnt = await verify(token, right);
        expect(burnt.status).toBe(400);
        expect(burnt.body.error).toBe('VERIFICATION_CODE_EXPIRED');

        await sendCode(token);
        expect((await verify(token, lastCode())).status).toBe(200);
    });

    it('does not accept the same code twice', async () => {
        const { token } = await fixtures.create();
        await sendCode(token);
        const code = lastCode();
        expect((await verify(token, code)).status).toBe(200);

        const again = await verify(token, code);

        expect(again.status).toBe(400);
        expect(again.body.error).toBe('VERIFICATION_CODE_EXPIRED');
    });

    it('a new code replaces the previous one', async () => {
        const { token } = await fixtures.create();
        await sendCode(token);
        const first = lastCode();
        await sendCode(token);
        const second = lastCode();

        if (first !== second) expect((await verify(token, first)).body.error).toBe('INVALID_VERIFICATION_CODE');
        expect((await verify(token, second)).status).toBe(200);
    });

    it('limits how many codes can be requested for one delivery', async () => {
        const { token } = await fixtures.create();
        for (let i = 0; i < 3; i++) expect((await sendCode(token)).status).toBe(200);
        const before = mails.length;

        const res = await sendCode(token);

        expect(res.status).toBe(429);
        expect(res.body.error).toBe('VERIFICATION_CODE_RATE_LIMITED');
        expect(mails).toHaveLength(before);
    });

    it('is a 503 and leaves no code when the email bounces', async () => {
        const { token } = await fixtures.create({ email: BOUNCING_EMAIL });

        const res = await sendCode(token);

        expect(res.status).toBe(503);
        expect(res.body.error).toBe('VERIFICATION_CODE_NOT_SENT');
        const verified = await verify(token, '123456');
        expect(verified.body.error).toBe('VERIFICATION_CODE_EXPIRED');
    });

    it('is a 409 with its reason when the self-service is over, there is no email or nothing is configured', async () => {
        const elapsed = await fixtures.create({ notifiedAt: new Date(Date.now() - 721 * MIN) });
        const noEmail = await fixtures.create({ email: null });
        const bounced = await fixtures.create({ notifiedAt: null });
        const before = mails.length;

        expect((await sendCode(elapsed.token)).body).toMatchObject({ statusCode: 409, error: 'RESCHEDULE_NOT_AVAILABLE', details: { reason: 'window_elapsed' } });
        expect((await sendCode(noEmail.token)).body.details).toEqual({ reason: 'no_contact_email' });
        expect((await sendCode(bounced.token)).body.details).toEqual({ reason: 'no_valid_notice' });
        expect((await verify(elapsed.token, '123456')).status).toBe(409);

        const open = await fixtures.create();
        await setSetting('reschedule_code_expiry_minutes', '');
        expect((await sendCode(open.token)).body.details).toEqual({ reason: 'not_configured' });
        await setSetting('reschedule_code_expiry_minutes', '10');
        expect(mails).toHaveLength(before);
    });

    it('answers the same 404 as the page for an unknown or malformed token', async () => {
        for (const token of ['00000000-0000-4000-8000-000000000000', 'not-a-token!']) {
            const send = await sendCode(token);
            const check = await verify(token, '123456');

            for (const res of [send, check]) {
                expect(res.status).toBe(404);
                expect(res.body).toMatchObject({ error: 'TRACKING_LINK_NOT_FOUND', message: 'Tracking link not found.' });
                expect(res.body.path).toBe(`/${prefix}/public/tracking/:token/verification-code${res === check ? '/verify' : ''}`);
            }
        }
    });

    it('never writes the token to the audit trail', async () => {
        const { token, dispatchId } = await fixtures.create();
        await sendCode(token);
        await verify(token, wrongOf(lastCode()));
        await verify(token, lastCode());

        const [{ count }] = await db.query(
            `SELECT COUNT(*)::int AS count FROM dispatch_events WHERE dispatch_id = $1 AND (reason LIKE $2 OR metadata::text LIKE $2 OR detail LIKE $2)`,
            [dispatchId, `%${token}%`],
        );
        expect(count).toBe(0);
    });
});
