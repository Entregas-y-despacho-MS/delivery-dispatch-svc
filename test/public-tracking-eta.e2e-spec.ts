// ST-40.1 — ETA, driver and position in the public tracking page, end to end.
//
// Boots the real AppModule against a real database and calls the public route over HTTP with no credential.
// OSRM is the double of the planner (1 km = 60 s) so the minutes are exact and its failure can be switched on;
// the cache is the in-memory one of the e2e config (a 60 s TTL cannot be waited for, so the entry is deleted).
// Everything carries a per-run tag and is removed in afterAll.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { FakeOsrm } from '../src/app/planning/domain/plan-fixtures.helper-spec.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { CacheService } from '../src/plugins/cache/cache.port.js';
import { OsrmUnavailableException } from '../src/plugins/osrm/exceptions/index.js';
import { OsrmPort } from '../src/plugins/osrm/osrm.port.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { TrackedFixtures } from './helpers/tracked-dispatch.fixtures.js';

const MIN = 60_000;

describe('Public tracking: ETA and live data (e2e, ST-40.1)', () => {
    let app: INestApplication;
    let db: DataSource;
    let cache: CacheService;
    let fixtures: TrackedFixtures;
    let prefix: string;
    let warehouse: { id: number; lat: number; lon: number };
    let zoneId: number;
    let driverRoleId: number;
    let userSeq = 0;
    const osrm = new FakeOsrm();

    const run = Date.now().toString(36).toUpperCase();
    const usernamePrefix = 'e2e_eta_';
    const http = () => request(app.getHttpServer());
    const view = (token: string) => http().get(`/${prefix}/public/tracking/${token}`);

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(OsrmPort).useValue(osrm)
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
        cache = moduleRef.get(CacheService);
        fixtures = new TrackedFixtures(db, `E2EETA-${run}`);

        warehouse = (await fixtures.warehouses())[0];
        zoneId = await fixtures.createZone('ETA');
        [{ role_id: driverRoleId }] = await db.query(`SELECT role_id FROM roles WHERE name = 'driver'`);
    });

    beforeEach(() => {
        osrm.failWith = null;
        osrm.calls.length = 0;
    });

    afterAll(async () => {
        if (db) {
            await fixtures.cleanup();
            await db.query(`DELETE FROM users WHERE username LIKE $1`, [`${usernamePrefix}%_${run}`]);
        }
        await app?.close();
    });

    /** A route with its own driver and vehicle (one active route per driver and vehicle). */
    async function route(): Promise<{ batchId: number; driverName: string; plate: string }> {
        const seq = ++userSeq;
        const driverName = `Conductor ETA ${run} ${seq}`;
        const [{ user_id }] = await db.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change, active)
             VALUES ($1, $2, $3, $4, false, true) RETURNING user_id`,
            [driverRoleId, driverName, `${usernamePrefix}${seq}_${run}`, await hashPassword('E2eTest1234')],
        );
        const vehicleId = await fixtures.createVehicle();
        const batchId = await fixtures.createBatch({ shiftDate: '2026-11-05', vehicleId, zoneId, warehouseId: warehouse.id });
        await db.query(`UPDATE route_batches SET driver_id = $2 WHERE route_batch_id = $1`, [batchId, user_id]);
        const [{ plate }] = await db.query(`SELECT plate FROM vehicles WHERE vehicle_id = $1`, [vehicleId]);
        return { batchId, driverName, plate };
    }

    /** The driver was last seen at the warehouse. */
    async function seenAtWarehouse(dispatchId: number): Promise<void> {
        await db.query(
            `UPDATE dispatches SET last_latitude = $2, last_longitude = $3, last_location_at = NOW() WHERE dispatch_id = $1`,
            [dispatchId, warehouse.lat, warehouse.lon],
        );
    }

    const stop = (batchId: number, sequence: number, km: number, status: string, windowEnd = new Date(Date.now() + 90 * MIN)) =>
        fixtures.create({ routeBatchId: batchId, sequence, km, status, zoneId, warehouseId: warehouse.id, windowEnd });

    it('in_transit: ETA with OSRM from the last position, the driver with the vehicle and the position', async () => {
        const { batchId, driverName, plate } = await route();
        const own = await stop(batchId, 1, 3, 'in_transit');
        await seenAtWarehouse(own.dispatchId);

        const res = await view(own.token);

        expect(res.status).toBe(200);
        expect(res.body.eta).toMatchObject({ minutes: 3, source: 'osrm' });
        expect(Number.isNaN(Date.parse(res.body.eta.calculatedAt))).toBe(false);
        expect(res.body.driver).toEqual({ name: driverName, vehicleType: 'camioneta', vehiclePlate: plate });
        expect(res.body.location.latitude).toBeCloseTo(warehouse.lat, 5);
        expect(res.body.location.longitude).toBeCloseTo(warehouse.lon, 5);
        expect(Number.isNaN(Date.parse(res.body.location.recordedAt))).toBe(false);
    });

    it('out_for_delivery: ETA through the stop that comes first, the driver, and no position', async () => {
        const { batchId, driverName } = await route();
        const first = await stop(batchId, 1, 3, 'in_transit');
        const own = await stop(batchId, 2, 5, 'out_for_delivery');
        await seenAtWarehouse(first.dispatchId); // only the stop in transit receives the pings of the app

        const res = await view(own.token);

        expect(res.status).toBe(200);
        expect(res.body.eta).toMatchObject({ minutes: 5, source: 'osrm' }); // 3 km + 2 km
        expect(res.body.driver.name).toBe(driverName);
        expect(res.body.location).toBeNull();
        expect(JSON.stringify(res.body)).not.toContain(String(warehouse.lat));
    });

    it('a stop already delivered no longer counts in the ETA of the next one', async () => {
        const { batchId } = await route();
        const done = await stop(batchId, 1, 3, 'delivered');
        const own = await stop(batchId, 2, 5, 'out_for_delivery');
        await seenAtWarehouse(done.dispatchId);

        const res = await view(own.token);

        expect(res.body.eta).toMatchObject({ minutes: 5, source: 'osrm' }); // straight to 5 km
        expect(osrm.calls[0]).toHaveLength(2);
    });

    it('OSRM down: the promised slot instead of the ETA, with a 200 and no error', async () => {
        const { batchId } = await route();
        const own = await stop(batchId, 1, 3, 'in_transit');
        await seenAtWarehouse(own.dispatchId);
        osrm.failWith = new OsrmUnavailableException(5000, 'timeout');

        const res = await view(own.token);

        expect(res.status).toBe(200);
        expect(res.body.eta.source).toBe('window');
        expect(res.body.eta.minutes).toBeGreaterThanOrEqual(89);
        expect(res.body.eta.minutes).toBeLessThanOrEqual(90);
        expect(res.body.driver).not.toBeNull();
        expect(res.body.location).not.toBeNull();
    });

    it('the driver has not reported a position yet: the slot as ETA and no location', async () => {
        const { batchId } = await route();
        const own = await stop(batchId, 1, 3, 'in_transit');

        const res = await view(own.token);

        expect(res.status).toBe(200);
        expect(res.body.eta.source).toBe('window');
        expect(res.body.location).toBeNull();
        expect(res.body.driver).not.toBeNull();
        expect(osrm.calls).toHaveLength(0);
    });

    it('cache: the second request of the minute does not ask OSRM again and keeps the same calculation', async () => {
        const { batchId } = await route();
        const own = await stop(batchId, 1, 3, 'in_transit');
        await seenAtWarehouse(own.dispatchId);

        const first = await view(own.token);
        osrm.failWith = new OsrmUnavailableException(5000); // would break a new calculation
        const second = await view(own.token);

        expect(osrm.calls).toHaveLength(1);
        expect(second.body.eta).toEqual(first.body.eta);
        expect(second.body.eta.source).toBe('osrm');
        expect(await cache.get(`tracking:eta:${own.dispatchId}`)).not.toBeNull();
    });

    it('cache: once the entry expires the ETA is calculated again', async () => {
        const { batchId } = await route();
        const own = await stop(batchId, 1, 3, 'in_transit');
        await seenAtWarehouse(own.dispatchId);
        await view(own.token);

        await cache.delete(`tracking:eta:${own.dispatchId}`); // the 60 s TTL is the cache's business, not waited for here
        osrm.failWith = new OsrmUnavailableException(5000);
        const res = await view(own.token);

        expect(osrm.calls).toHaveLength(2);
        expect(res.body.eta.source).toBe('window');
    });

    it.each(['scheduled', 'assigned', 'delivered', 'not_delivered'])('%s: no ETA, no driver, no position, and nothing is asked of OSRM', async (status) => {
        const { batchId } = await route();
        const own = await stop(batchId, 1, 3, status);
        await seenAtWarehouse(own.dispatchId);

        const res = await view(own.token);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status, eta: null, driver: null, location: null });
        expect(osrm.calls).toHaveLength(0);
    });

    it('an order without a route has nothing live either', async () => {
        const own = await fixtures.create({ status: 'out_for_delivery', shiftDate: null });

        const res = await view(own.token);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ eta: null, driver: null, location: null });
    });

    it('never shows contact data of the driver or the customer, the tracking token or any identifier', async () => {
        const { batchId } = await route();
        // `users` has no phone column; the only contact data of the driver is the email, which must not come out either.
        await db.query(
            `UPDATE users SET email = $2 WHERE user_id = (SELECT driver_id FROM route_batches WHERE route_batch_id = $1)`,
            [batchId, 'driver.eta@example.test'],
        );
        const own = await stop(batchId, 1, 3, 'in_transit');
        await seenAtWarehouse(own.dispatchId);

        const res = await view(own.token);

        const body = JSON.stringify(res.body);
        for (const secret of ['driver.eta@example.test', '70000000', own.token, 'Calle Secreta']) expect(body).not.toContain(secret);
        expect(body).not.toMatch(/phone|token|"id"|dispatchId|driverId|userId|username|email/i);
        expect(Object.keys(res.body.driver).sort()).toEqual(['name', 'vehiclePlate', 'vehicleType']);
        expect(Object.keys(res.body.location).sort()).toEqual(['latitude', 'longitude', 'recordedAt']);
        expect(Object.keys(res.body.eta).sort()).toEqual(['calculatedAt', 'minutes', 'source']);
    });
});
