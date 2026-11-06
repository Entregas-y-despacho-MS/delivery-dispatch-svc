import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { User } from '../src/modules/auth/users/entities/user.entity.js';
import { Role } from '../src/modules/auth/roles/entities/role.entity.js';
import { Setting } from '../src/modules/settings/entities/setting.entity.js';
import { SettingsService } from '../src/modules/settings/services/settings.service.js';
import { ALERT_THRESHOLD_KEYS, SETTINGS_CACHE_KEY, SETTINGS_VERSION_KEY } from '../src/modules/settings/settings.constants.js';
import { CacheService } from '../src/plugins/cache/cache.port.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';

const PASSWORD = 'E2eTest1234';
const ROLES = ['supervisor', 'coordinator', 'admin', 'driver'] as const;
const KEYS = Object.values(ALERT_THRESHOLD_KEYS);
const VALID = { slaAlertMinOnTimePct: 85, gpsStaleAlertMinutes: 10, driverIncidentAlertPerDay: 4 };

describe('Alert thresholds (e2e)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let settingsService: SettingsService;
    let cache: CacheService;
    let apiPrefix: string;
    const tokens = new Map<string, string>();
    const userIds: number[] = [];
    const initialValues = new Map<string, string>();
    const insertedKeys: string[] = [];

    const url = () => `/${apiPrefix}/settings/alert-thresholds`;
    const http = () => request(app.getHttpServer());
    const as = (role: string) => ({ Authorization: `Bearer ${tokens.get(role)}` });
    const stored = async () => Object.fromEntries((await dataSource.getRepository(Setting).findBy(KEYS.map((key) => ({ key })))).map((s) => [s.key, s.value]));

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        apiPrefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(apiPrefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();

        dataSource = moduleRef.get(DataSource);
        settingsService = moduleRef.get(SettingsService);
        cache = moduleRef.get(CacheService);
        await cache.delete(SETTINGS_CACHE_KEY);

        const settingRepo = dataSource.getRepository(Setting);
        for (const key of [...KEYS, SETTINGS_VERSION_KEY]) {
            const existing = await settingRepo.findOneBy({ key });
            if (existing) initialValues.set(key, existing.value);
        }
        const fixtures = [
            { key: ALERT_THRESHOLD_KEYS.slaAlertMinOnTimePct, value: '90', description: null },
            { key: ALERT_THRESHOLD_KEYS.gpsStaleAlertMinutes, value: '5', description: null },
            { key: ALERT_THRESHOLD_KEYS.driverIncidentAlertPerDay, value: '3', description: null },
            { key: SETTINGS_VERSION_KEY, value: '0', description: 'Internal monotonically increasing version for operational settings.' },
        ];
        for (const setting of fixtures) {
            if (await settingRepo.findOneBy({ key: setting.key })) continue;
            await settingRepo.insert(setting);
            insertedKeys.push(setting.key);
        }
        await settingsService.refresh();

        const userRepo = dataSource.getRepository(User);
        const passwordHash = await hashPassword(PASSWORD);
        const suffix = Date.now();
        for (const name of ROLES) {
            const role = await dataSource.getRepository(Role).findOneByOrFail({ name });
            const user = await userRepo.save(userRepo.create({ fullName: `Thresholds ${name} E2E`, username: `thresholds_${name}_${suffix}`, passwordHash, roleId: role.id, active: true, requiresPwdChange: false }));
            userIds.push(user.id);
            const login = await http().post(`/${apiPrefix}/auth/login`).send({ username: user.username, password: PASSWORD });
            tokens.set(name, login.body.accessToken as string);
        }
    });

    afterAll(async () => {
        if (!dataSource || !app) return;
        const settingRepo = dataSource.getRepository(Setting);
        for (const [key, value] of initialValues) await settingRepo.update(key, { value });
        if (insertedKeys.length) await settingRepo.delete(insertedKeys);
        await cache.delete(SETTINGS_CACHE_KEY);
        await settingsService.refresh();
        if (userIds.length) await dataSource.getRepository(User).delete(userIds);
        await app.close();
    });

    describe('permissions', () => {
        it('needs a token', async () => {
            expect((await http().get(url())).status).toBe(401);
            expect((await http().put(url()).send(VALID)).status).toBe(401);
        });

        it.each(['supervisor', 'coordinator'])('%s can read', async (role) => {
            const response = await http().get(url()).set(as(role));
            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ slaAlertMinOnTimePct: expect.any(Number), gpsStaleAlertMinutes: expect.any(Number), driverIncidentAlertPerDay: expect.any(Number) });
        });

        it.each(['admin', 'driver'])('%s cannot read', async (role) => {
            expect((await http().get(url()).set(as(role))).status).toBe(403);
        });

        it.each(['coordinator', 'admin', 'driver'])('%s cannot change the thresholds', async (role) => {
            const before = await stored();

            const response = await http().put(url()).set(as(role)).send(VALID);

            expect(response.status).toBe(403);
            expect(await stored()).toEqual(before);
        });
    });

    describe('generic PUT /settings/:key', () => {
        it.each(KEYS)('refuses %s with 403 SETTING_MANAGED_SEPARATELY and stores nothing', async (key) => {
            const before = await stored();
            const version = await settingsService.getVersion();

            const response = await http().put(`/${apiPrefix}/settings/${key}`).set(as('coordinator')).send({ value: '50' });

            expect(response.status).toBe(403);
            expect(response.body.error).toBe('SETTING_MANAGED_SEPARATELY');
            expect(await stored()).toEqual(before);
            expect(await settingsService.getVersion()).toBe(version);
        });
    });

    describe('validation', () => {
        it.each([
            ['percentage above 100', { ...VALID, slaAlertMinOnTimePct: 101 }],
            ['negative percentage', { ...VALID, slaAlertMinOnTimePct: -1 }],
            ['GPS minutes below 1', { ...VALID, gpsStaleAlertMinutes: 0 }],
            ['incidents below 1', { ...VALID, driverIncidentAlertPerDay: 0 }],
            ['decimal value', { ...VALID, gpsStaleAlertMinutes: 2.5 }],
            ['text instead of a number', { ...VALID, gpsStaleAlertMinutes: '5' }],
            ['missing field', { slaAlertMinOnTimePct: 85, gpsStaleAlertMinutes: 10 }],
            ['unknown field', { ...VALID, extra: 1 }],
        ])('answers 400 and stores nothing: %s', async (_name, body) => {
            const before = await stored();
            const version = await settingsService.getVersion();

            const response = await http().put(url()).set(as('supervisor')).send(body);

            expect(response.status).toBe(400);
            expect(await stored()).toEqual(before);
            expect(await settingsService.getVersion()).toBe(version);
        });
    });

    describe('saving and cache', () => {
        it('saves the three values, bumps the version once and returns the new values', async () => {
            const version = await settingsService.getVersion();

            const response = await http().put(url()).set(as('supervisor')).send(VALID);

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject(VALID);
            expect(await stored()).toEqual({
                [ALERT_THRESHOLD_KEYS.slaAlertMinOnTimePct]: '85',
                [ALERT_THRESHOLD_KEYS.gpsStaleAlertMinutes]: '10',
                [ALERT_THRESHOLD_KEYS.driverIncidentAlertPerDay]: '4',
            });
            expect(await settingsService.getVersion()).toBe(version + 1);
        });

        it('replaces the cached snapshot, so the next read and the alert evaluator see the new values', async () => {
            await http().put(url()).set(as('supervisor')).send({ slaAlertMinOnTimePct: 70, gpsStaleAlertMinutes: 15, driverIncidentAlertPerDay: 6 });

            expect(await cache.get(SETTINGS_CACHE_KEY)).toContain('"value":"15"');
            expect(await settingsService.getNumber(ALERT_THRESHOLD_KEYS.slaAlertMinOnTimePct, 0)).toBe(70);
            expect(await settingsService.getNumber(ALERT_THRESHOLD_KEYS.gpsStaleAlertMinutes, 0)).toBe(15);
            expect(await settingsService.getNumber(ALERT_THRESHOLD_KEYS.driverIncidentAlertPerDay, 0)).toBe(6);
            const read = await http().get(url()).set(as('coordinator'));
            expect(read.body).toMatchObject({ slaAlertMinOnTimePct: 70, gpsStaleAlertMinutes: 15, driverIncidentAlertPerDay: 6 });
        });

        it('accepts the boundary values 0 and 100 for the percentage', async () => {
            expect((await http().put(url()).set(as('supervisor')).send({ ...VALID, slaAlertMinOnTimePct: 0 })).status).toBe(200);
            expect((await http().put(url()).set(as('supervisor')).send({ ...VALID, slaAlertMinOnTimePct: 100 })).status).toBe(200);
        });

        it('is not shadowed by PUT /settings/:key', async () => {
            const response = await http().put(url()).set(as('supervisor')).send(VALID);

            expect(response.status).toBe(200);
            expect(response.body).not.toHaveProperty('key');
        });
    });
});
