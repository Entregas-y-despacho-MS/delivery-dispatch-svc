// ST-42.1 — public rating through the real HTTP stack and PostgreSQL unique constraint.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { DriverMetricsPeriod } from '../src/app/driver-metrics/domain/metrics-period.js';
import { DriverMetricsService } from '../src/app/driver-metrics/services/driver-metrics.service.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { todayInOperatingTimeZone } from '../src/modules/dispatch/dispatches/utils/operating-date.util.js';
import { TrackedFixtures } from './helpers/tracked-dispatch.fixtures.js';

describe('Public tracking rating (e2e, ST-42.1)', () => {
    let app: INestApplication;
    let db: DataSource;
    let metrics: DriverMetricsService;
    let fixtures: TrackedFixtures;
    let prefix: string;
    let driverId: number;
    let delivered: { token: string; dispatchId: number };
    let inTransit: { token: string; dispatchId: number };
    const run = Date.now().toString(36).toUpperCase();
    const username = `e2e_rating_${run}`;
    const http = () => request(app.getHttpServer());
    const view = (token: string) => http().get(`/${prefix}/public/tracking/${token}`);
    const rate = (token: string, body: unknown) => http().post(`/${prefix}/public/tracking/${token}/rating`).send(body);

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
        metrics = moduleRef.get(DriverMetricsService);
        fixtures = new TrackedFixtures(db, `E2ERATING-${run}`);

        const [{ role_id: driverRoleId }] = await db.query(`SELECT role_id FROM roles WHERE name = 'driver'`);
        const [{ user_id: newDriverId }] = await db.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change, active)
             VALUES ($1, $2, $3, $4, false, true) RETURNING user_id`,
            [driverRoleId, `Conductor rating ${run}`, username, await hashPassword('E2eTest1234')],
        );
        driverId = Number(newDriverId);

        const warehouse = (await fixtures.warehouses())[0];
        const zoneId = await fixtures.createZone('RATE');
        const vehicleId = await fixtures.createVehicle();
        const batchId = await fixtures.createBatch({
            shiftDate: todayInOperatingTimeZone(), vehicleId, zoneId, warehouseId: warehouse.id,
        });
        await db.query(`UPDATE route_batches SET driver_id = $2 WHERE route_batch_id = $1`, [batchId, driverId]);
        delivered = await fixtures.create({
            status: 'delivered', routeBatchId: batchId, sequence: 1, zoneId, warehouseId: warehouse.id,
        });
        inTransit = await fixtures.create({
            status: 'in_transit', routeBatchId: batchId, sequence: 2, zoneId, warehouseId: warehouse.id,
        });
        await db.query(`UPDATE dispatches SET closed_at = NOW() WHERE dispatch_id = $1`, [delivered.dispatchId]);
    });

    afterAll(async () => {
        if (db?.isInitialized) {
            await fixtures.cleanup();
            await db.query(`DELETE FROM users WHERE username = $1`, [username]);
        }
        await app?.close();
    });

    it('GET exposes canRate only for a delivered dispatch without a rating', async () => {
        const res = await view(delivered.token);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'delivered', rating: null, canRate: true });

        const notDelivered = await view(inTransit.token);
        expect(notDelivered.status).toBe(200);
        expect(notDelivered.body).toMatchObject({ status: 'in_transit', rating: null, canRate: false });
    });

    it('rejects malformed scores with 400 and does not persist them', async () => {
        for (const score of [0, 6, 2.5, '5']) {
            const res = await rate(delivered.token, { score });
            expect(res.status, `score ${String(score)}`).toBe(400);
            expect(res.body.error).toBe('Bad Request');
        }
        const [{ count }] = await db.query(`SELECT COUNT(*)::int AS count FROM dispatch_ratings WHERE dispatch_id = $1`, [delivered.dispatchId]);
        expect(Number(count)).toBe(0);
    });

    it('accepts a valid score, returns it in GET, disables canRate, and invalidates cached driver metrics after commit', async () => {
        const before = await metrics.get(driverId, DriverMetricsPeriod.TODAY);
        expect(before).toMatchObject({ rating: null, ratingsCount: 0 });

        const res = await rate(delivered.token, { score: 4 });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ score: 4 });
        expect(Number.isNaN(Date.parse(res.body.createdAt))).toBe(false);
        const viewRes = await view(delivered.token);
        expect(viewRes.body).toMatchObject({ rating: { score: 4 }, canRate: false });

        const after = await metrics.get(driverId, DriverMetricsPeriod.TODAY);
        expect(after).toMatchObject({ rating: 4, ratingsCount: 1 });
    });

    it('uses the unique database index to reject a second rating with 409', async () => {
        const res = await rate(delivered.token, { score: 5 });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('RATING_ALREADY_SUBMITTED');
        const [{ count }] = await db.query(`SELECT COUNT(*)::int AS count FROM dispatch_ratings WHERE dispatch_id = $1`, [delivered.dispatchId]);
        expect(Number(count)).toBe(1);
    });

    it('returns 409 when the order has not been delivered', async () => {
        const res = await rate(inTransit.token, { score: 5 });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('RATING_NOT_ALLOWED');
    });

    it('uses the existing public token validation for unknown links', async () => {
        const res = await rate('00000000-0000-4000-8000-000000000000', { score: 5 });
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('TRACKING_LINK_NOT_FOUND');
    });
});
