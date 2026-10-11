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
import { SETTINGS_CACHE_KEY, SETTINGS_VERSION_HEADER, SETTINGS_VERSION_KEY } from '../src/modules/settings/settings.constants.js';
import { CacheService } from '../src/plugins/cache/cache.port.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';

const PASSWORD = 'E2eTest1234';

describe('Operational settings (e2e)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let settingsService: SettingsService;
    let cache: CacheService;
    let apiPrefix: string;
    let coordinatorToken: string;
    let adminToken: string;
    let driverToken: string;
    let coordinatorId: number;
    let adminId: number;
    let driverId: number;
    const initialSettingValues = new Map<string, string>();
    let syncEventId: string;
    const insertedKeys: string[] = [];

    const api = (path: string) => `/${apiPrefix}${path}`;
    const http = () => request(app.getHttpServer());

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
        for (const key of ['plan_generation_times', 'plan_non_working_dates', SETTINGS_VERSION_KEY]) {
            const existing = await settingRepo.findOneBy({ key });
            if (existing) initialSettingValues.set(key, existing.value);
        }
        const fixtureSettings = [
            { key: 'plan_generation_times', value: '08:30,13:30', description: null },
            { key: 'plan_horizon_days', value: '4', description: null },
            { key: 'plan_non_working_dates', value: '', description: null },
            { key: 'service_min_operating_days', value: '2', description: null },
            { key: 'service_max_operating_days', value: '3', description: null },
            { key: 'morning_window_start', value: '09:00', description: null },
            { key: 'morning_window_end', value: '13:00', description: null },
            { key: 'afternoon_window_start', value: '14:00', description: null },
            { key: 'afternoon_window_end', value: '18:00', description: null },
            { key: 'route_cutoff_time', value: '15:00', description: null },
            { key: 'final_review_end_time', value: '16:00', description: null },
            { key: 'route_reminder_time', value: '16:30', description: null },
            { key: 'final_review_escalation_time', value: '07:00', description: null },
            { key: 'warehouse_prep_end_time', value: '08:15', description: null },
            { key: SETTINGS_VERSION_KEY, value: '0', description: 'Internal monotonically increasing version for operational settings.' },
        ];
        for (const setting of fixtureSettings) {
            if (await settingRepo.findOneBy({ key: setting.key })) continue;
            await settingRepo.insert(setting);
            insertedKeys.push(setting.key);
        }
        await settingsService.refresh();

        const roleRepo = dataSource.getRepository(Role);
        const coordinatorRole = await roleRepo.findOneByOrFail({ name: 'coordinator' });
        const adminRole = await roleRepo.findOneByOrFail({ name: 'admin' });
        const driverRole = await roleRepo.findOneByOrFail({ name: 'driver' });
        const userRepo = dataSource.getRepository(User);
        const passwordHash = await hashPassword(PASSWORD);
        const suffix = Date.now();
        syncEventId = `01933b6e-7f2a-7c3d-9a1b-${suffix.toString(16).padStart(12, '0')}`;
        const [coordinator, admin, driver] = await userRepo.save([
            userRepo.create({ fullName: 'Settings Coordinator E2E', username: `settings_coordinator_${suffix}`, passwordHash, roleId: coordinatorRole.id, active: true, requiresPwdChange: false }),
            userRepo.create({ fullName: 'Settings Admin E2E', username: `settings_admin_${suffix}`, passwordHash, roleId: adminRole.id, active: true, requiresPwdChange: false }),
            userRepo.create({ fullName: 'Settings Driver E2E', username: `settings_driver_${suffix}`, passwordHash, roleId: driverRole.id, active: true, requiresPwdChange: false }),
        ]);
        coordinatorId = coordinator.id;
        adminId = admin.id;
        driverId = driver.id;

        const login = async (username: string) => (await http().post(api('/auth/login')).send({ username, password: PASSWORD })).body.accessToken as string;
        coordinatorToken = await login(coordinator.username);
        adminToken = await login(admin.username);
        driverToken = await login(driver.username);
    });

    afterAll(async () => {
        if (!dataSource || !app) return;
        const settingRepo = dataSource.getRepository(Setting);
        for (const [key, value] of initialSettingValues) {
            await settingRepo.update(key, { value });
        }
        if (insertedKeys.length) await settingRepo.delete(insertedKeys);
        await cache.delete(SETTINGS_CACHE_KEY);
        await settingsService.refresh();
        await dataSource.getRepository(User).delete([coordinatorId, adminId, driverId].filter(Boolean));
        await app.close();
    });

    it('coordinator reads operational settings without exposing the internal version key', async () => {
        const response = await http().get(api('/settings')).set({ Authorization: `Bearer ${coordinatorToken}` });

        expect(response.status).toBe(200);
        expect(response.body.map((setting: Setting) => setting.key)).toContain('plan_generation_times');
        expect(response.body.map((setting: Setting) => setting.key)).not.toContain(SETTINGS_VERSION_KEY);
    });

    it('a valid update is saved and increments the version', async () => {
        const before = await settingsService.getVersion();
        const response = await http().put(api('/settings/plan_generation_times'))
            .set({ Authorization: `Bearer ${coordinatorToken}` })
            .send({ value: '08:30,12:30' });

        expect(response.status).toBe(200);
        expect(response.body.value).toBe('08:30,12:30');
        expect(await settingsService.getVersion()).toBe(before + 1);
    });

    it('accepts an empty list of non-working dates', async () => {
        const response = await http().put(api('/settings/plan_non_working_dates'))
            .set({ Authorization: `Bearer ${coordinatorToken}` })
            .send({ value: '' });

        expect(response.status).toBe(200);
        expect(response.body.value).toBe('');
    });

    it.each([
        ['plan_horizon_days', '0'],
        ['plan_generation_times', '08:30,not-a-time'],
    ])('rejects invalid configuration %s = %j', async (key, value) => {
        const response = await http().put(api(`/settings/${key}`))
            .set({ Authorization: `Bearer ${coordinatorToken}` })
            .send({ value });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe('INVALID_SETTING_VALUE');
    });

    it('rejects an invalid time chain', async () => {
        const review = await dataSource.getRepository(Setting).findOneByOrFail({ key: 'final_review_end_time' });
        const response = await http().put(api('/settings/route_cutoff_time'))
            .set({ Authorization: `Bearer ${coordinatorToken}` })
            .send({ value: review.value });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe('INVALID_SETTING_VALUE');
    });

    it('rejects an unauthorized role with 403', async () => {
        const response = await http().put(api('/settings/plan_generation_times'))
            .set({ Authorization: `Bearer ${adminToken}` })
            .send({ value: '08:30,12:30' });

        expect(response.status).toBe(403);
        expect(response.body.error).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('includes the current parameter version in the next mobile sync response', async () => {
        const response = await http().post(api('/sync/evidences'))
            .set({ Authorization: `Bearer ${driverToken}` })
            .field('clientEventId', syncEventId)
            .field('dispatchId', '2147483647')
            .field('type', 'otp');

        expect(response.status).toBe(201);
        expect(response.headers[SETTINGS_VERSION_HEADER.toLowerCase()]).toBe(String(await settingsService.getVersion()));
    });
});
