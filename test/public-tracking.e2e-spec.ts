// ST-224.1 — Public tracking page by token, end to end (stage 1: access).
//
// Boots the real AppModule against a real database and calls the public route over HTTP with no credential.
// Dispatches are inserted in the exact state each case needs; everything carries a per-run tag and is removed in
// afterAll. The settings the rescheduling needs ship blank, so the suite sets them and restores the originals.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { SettingsService } from '../src/modules/settings/services/settings.service.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { TrackedFixtures } from './helpers/tracked-dispatch.fixtures.js';

const MIN = 60_000;
const SETTINGS_UNDER_TEST = ['warehouse_prep_lead_minutes', 'reschedule_code_expiry_minutes'];

describe('Public tracking by token (e2e, ST-224.1)', () => {
    let app: INestApplication;
    let db: DataSource;
    let settings: SettingsService;
    let fixtures: TrackedFixtures;
    let prefix: string;
    const originals = new Map<string, string>();

    const run = Date.now().toString(36).toUpperCase();
    const http = () => request(app.getHttpServer());
    const view = (token: string) => http().get(`/${prefix}/public/tracking/${token}`);

    async function setSetting(key: string, value: string) {
        await db.query(`UPDATE settings SET setting_value = $2, updated_at = NOW() WHERE setting_key = $1`, [key, value]);
        await settings.refresh();
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
        settings = moduleRef.get(SettingsService);
        fixtures = new TrackedFixtures(db, `E2EPUBTRK-${run}`);

        for (const key of SETTINGS_UNDER_TEST) {
            const [row] = await db.query(`SELECT setting_value FROM settings WHERE setting_key = $1`, [key]);
            originals.set(key, row?.setting_value ?? '');
        }
    });

    afterAll(async () => {
        if (db) {
            for (const [key, value] of originals) await setSetting(key, value);
            await fixtures.cleanup();
        }
        await app?.close();
    });

    it('opens with the token alone: no login, state, date, slot and what the customer can do', async () => {
        const { token, trackingCode } = await fixtures.create();

        const res = await view(token);

        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).toMatchObject({
            trackingCode,
            status: 'scheduled',
            customerConfirmation: 'pending',
            deliveryDate: '2026-10-20',
            windowStart: '2026-10-20T13:00:00.000Z',
            windowEnd: '2026-10-20T15:00:00.000Z',
            selfService: { open: true, closedReason: null, rescheduleAttemptsLeft: 2, canConfirm: true, canRequestChange: true },
        });
    });

    it('shows no address, phone, OTP, photo, email or internal id', async () => {
        const { token, dispatchId } = await fixtures.create();

        const body = JSON.stringify((await view(token)).body);

        for (const secret of ['Calle Secreta', '70000000', 'customer@example.test', token]) expect(body).not.toContain(secret);
        expect(body).not.toMatch(/otp|photo|evidence|address|phone|email|"id"|dispatchId|routeBatch/i);
        expect(body).not.toContain(`"${dispatchId}"`);
    });

    it('never opens with the tracking code, and answers it exactly like an unknown token', async () => {
        const { trackingCode } = await fixtures.create();

        const byCode = await view(trackingCode);
        const unknown = await view('00000000-0000-4000-8000-000000000000');

        expect(byCode.status).toBe(404);
        expect(unknown.status).toBe(404);
        expect(byCode.body).toMatchObject({ statusCode: 404, error: 'TRACKING_LINK_NOT_FOUND', message: 'Tracking link not found.' });
        const strip = ({ timestamp: _t, ...rest }: Record<string, unknown>) => rest;
        expect(strip(byCode.body)).toEqual(strip(unknown.body));
    });

    it('answers the same 404 for malformed and expired tokens', async () => {
        const expired = await fixtures.create({ tokenExpiresAt: new Date(Date.now() - MIN) });
        const open = await fixtures.create({ tokenExpiresAt: new Date(Date.now() + 60 * MIN) });

        const bodies = [
            (await view(expired.token)).body,
            (await view('not-a-token!')).body,
            (await view('x'.repeat(300))).body,
        ];

        for (const body of bodies) {
            expect(body).toMatchObject({ statusCode: 404, error: 'TRACKING_LINK_NOT_FOUND', message: 'Tracking link not found.' });
        }
        // A token whose expiry is still ahead keeps working.
        expect((await view(open.token)).status).toBe(200);
    });

    it('does not echo the token in the error body', async () => {
        const res = await view('5b0a7c1e-0d0e-4a44-9d5f-3a1b2c3d4e5f');

        expect(res.status).toBe(404);
        expect(res.body.path).toBe(`/${prefix}/public/tracking/:token`);
        expect(JSON.stringify(res.body)).not.toContain('5b0a7c1e');
    });

    it('leaves only the change request once the original 12 h window has elapsed', async () => {
        const { token } = await fixtures.create({ notifiedAt: new Date(Date.now() - 721 * MIN) });

        const { body } = await view(token);

        expect(body.selfService).toMatchObject({
            open: false, closedReason: 'window_elapsed', canConfirm: false, canReschedule: false, canRequestChange: true,
        });
    });

    it('leaves only the change request when the notice never reached the customer (bounced email)', async () => {
        const { token } = await fixtures.create({ notifiedAt: null });

        const { body } = await view(token);

        expect(body.selfService).toMatchObject({
            open: false, closedReason: 'no_valid_notice', windowClosesAt: null, canConfirm: false, canReschedule: false, canRequestChange: true,
        });
    });

    it('closes the self-service when max_reschedule_attempts customer reschedulings were made', async () => {
        const { token, dispatchId } = await fixtures.create({ customerConfirmation: 'rescheduled' });
        await fixtures.addCustomerRescheduling(dispatchId);
        expect((await view(token)).body.selfService).toMatchObject({ open: true, rescheduleAttemptsLeft: 1 });

        await fixtures.addCustomerRescheduling(dispatchId);

        expect((await view(token)).body.selfService).toMatchObject({
            open: false, closedReason: 'max_attempts', rescheduleAttemptsLeft: 0, canReschedule: false, canRequestChange: true,
        });
    });

    it('closes the self-service after the customer confirmed', async () => {
        const { token } = await fixtures.create({ customerConfirmation: 'confirmed' });

        expect((await view(token)).body.selfService).toMatchObject({ open: false, closedReason: 'confirmed', canConfirm: false });
    });

    it('offers nothing for a delivery that is already on the road or done', async () => {
        for (const status of ['out_for_delivery', 'delivered']) {
            const { token } = await fixtures.create({ status });

            expect((await view(token)).body.selfService).toMatchObject({
                open: false, closedReason: 'not_open', canConfirm: false, canReschedule: false, canRequestChange: false,
            });
        }
    });

    it('offers rescheduling only when the warehouse lead time and the code validity are configured and there is an email', async () => {
        const { token } = await fixtures.create();
        const noEmail = await fixtures.create({ email: null });

        await setSetting('warehouse_prep_lead_minutes', '');
        await setSetting('reschedule_code_expiry_minutes', '');
        expect((await view(token)).body.selfService).toMatchObject({ open: true, canConfirm: true, canReschedule: false });

        await setSetting('warehouse_prep_lead_minutes', '60');
        expect((await view(token)).body.selfService.canReschedule).toBe(false);

        await setSetting('reschedule_code_expiry_minutes', '10');
        expect((await view(token)).body.selfService.canReschedule).toBe(true);
        // Without an email there is nowhere to send the code, but confirming still works.
        expect((await view(noEmail.token)).body.selfService).toMatchObject({ canConfirm: true, canReschedule: false });
    });
});
