// El generador de lotes incluye recojos domiciliarios junto con entregas.
//
// Levanta el AppModule real contra una base de datos real, con OSRM simulado (FakeOsrm) y la lectura de
// candidatos acotada a los pedidos, vehículos y conductores de esta corrida. Todo lo que crea lleva un
// prefijo único y se borra en afterAll; las claves `stop_service_minutes` y `planning_margin_pct` se
// restauran a su valor original.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { OsrmPort } from '../src/plugins/osrm/osrm.port.js';
import { PlanCandidatesRepository } from '../src/app/planning/services/plan-candidates.repository.js';
import { FakeOsrm } from '../src/app/planning/domain/plan-fixtures.helper-spec.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

describe('Plan generation with customer pickups (e2e)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const run = Date.now().toString(36).toUpperCase();
    const refPrefix = `E2EPLANPU-${run}-`;
    const userPrefix = `e2e_planpu_`;

    const fakeOsrm = new FakeOsrm();
    const scope = { dispatchIds: new Set<number>(), vehicleIds: new Set<number>(), driverIds: new Set<number>() };
    const originalSettings: Record<string, string> = {};
    let coordinatorToken = '';
    let zoneId = 0;
    let warehouse = { id: 0, lat: 0, lon: 0 };
    let statusId: Record<string, number> = {};
    let typeId: Record<string, number> = {};
    let seq = 0;

    class ScopedCandidates extends PlanCandidatesRepository {
        async findCandidates() {
            return (await super.findCandidates()).filter((d) => scope.dispatchIds.has(d.dispatchId));
        }
        async findOpenBatches(today: string) {
            return (await super.findOpenBatches(today)).filter((b) => b.stops.some((s) => scope.dispatchIds.has(s.dispatch.dispatchId)));
        }
        async findVehicles() {
            return (await super.findVehicles()).filter((v) => scope.vehicleIds.has(v.vehicleId));
        }
        async findDriverIds() {
            return (await super.findDriverIds()).filter((id) => scope.driverIds.has(id));
        }
    }

    const api = (path: string) => `/${apiPrefix}${path}`;
    const auth = () => ({ Authorization: `Bearer ${coordinatorToken}` });
    const generate = () => request(app.getHttpServer()).post(api('/planning/generate')).set(auth());
    const putSetting = (key: string, value: string) =>
        request(app.getHttpServer()).put(api(`/settings/${key}`)).set(auth()).send({ value });

    const newDelivery = async (km: number): Promise<number> => {
        const [{ dispatch_id }] = await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, delivery_zone_id, origin_warehouse_id, source_order_ref,
                                      delivery_address, delivery_latitude, delivery_longitude, estimated_weight_kg,
                                      order_confirmed_at, shipment_ready)
             VALUES ($1, $2, $3, $4, $5, 'Dirección de entrega', $6, $7, 10, NOW(), TRUE)
             RETURNING dispatch_id`,
            [typeId.delivery, statusId.pending, zoneId, warehouse.id, `${refPrefix}${++seq}`, warehouse.lat - km * 0.01, warehouse.lon],
        );
        scope.dispatchIds.add(dispatch_id);
        return dispatch_id as number;
    };

    const newPickup = async (km: number, over: { preferredPickupDate?: string | null } = {}): Promise<number> => {
        const [{ dispatch_id }] = await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, delivery_zone_id, destination_warehouse_id, source_order_ref,
                                      delivery_address, delivery_latitude, delivery_longitude, estimated_boxes, return_reason,
                                      preferred_pickup_date, shipment_ready)
             VALUES ($1, $2, $3, $4, $5, 'Dirección del cliente', $6, $7, 2, 'Garantía', ($8::date)::timestamp AT TIME ZONE 'America/La_Paz', TRUE)
             RETURNING dispatch_id`,
            [
                typeId.warehouse_return_pickup, statusId.pickup_scheduled, zoneId, warehouse.id, `${refPrefix}${++seq}`,
                warehouse.lat - km * 0.01, warehouse.lon,
                over.preferredPickupDate === undefined ? null : over.preferredPickupDate,
            ],
        );
        scope.dispatchIds.add(dispatch_id);
        return dispatch_id as number;
    };

    const stateOf = async (id: number) => (await dataSource.query(
        `SELECT s.name AS status, d.route_batch_id, d.sequence_order, d.scheduled_window_start, d.scheduled_window_end, d.version
           FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id) WHERE d.dispatch_id = $1`, [id]))[0];

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(OsrmPort).useValue(fakeOsrm)
            .overrideProvider(PlanCandidatesRepository)
            .useFactory({ factory: (ds: DataSource) => new ScopedCandidates(ds), inject: [DataSource] })
            .compile();
        app = moduleRef.createNestApplication();
        apiPrefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(apiPrefix);
        app.useGlobalPipes(new ValidationPipe({
            transform: true, whitelist: true, forbidNonWhitelisted: true,
            transformOptions: { enableImplicitConversion: false },
        }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        dataSource = moduleRef.get(DataSource);

        const roles: Record<string, number> = {};
        for (const r of await dataSource.query(`SELECT role_id AS id, name FROM roles`)) roles[r.name] = r.id;
        for (const s of await dataSource.query(`SELECT dispatch_status_id AS id, name FROM dispatch_statuses`)) statusId[s.name] = s.id;
        for (const t of await dataSource.query(`SELECT dispatch_type_id AS id, name FROM dispatch_types`)) typeId[t.name] = t.id;

        const passwordHash = await hashPassword('E2eTest1234');
        const makeUser = async (key: string, role: string) => {
            const [{ user_id }] = await dataSource.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change, active)
                 VALUES ($1, $2, $3, $4, false, true) RETURNING user_id`,
                [roles[role], `PlanPU ${key} ${run}`, `${userPrefix}${key}_${run}`, passwordHash],
            );
            return user_id as number;
        };
        await makeUser('coordinator', 'coordinator');
        scope.driverIds.add(await makeUser('driverA', 'driver'));
        const login = await request(app.getHttpServer()).post(api('/auth/login'))
            .send({ username: `${userPrefix}coordinator_${run}`, password: 'E2eTest1234' });
        coordinatorToken = login.body.accessToken as string;

        const [{ delivery_zone_id }] = await dataSource.query(
            `INSERT INTO delivery_zones (code, name, estimated_time_min) VALUES ($1, $2, 30) RETURNING delivery_zone_id`,
            [`PU${run}`.slice(0, 20), `Zona e2e pickups ${run}`],
        );
        zoneId = delivery_zone_id;

        const [wh] = await dataSource.query(`SELECT warehouse_id, latitude, longitude FROM warehouses WHERE active = TRUE ORDER BY warehouse_id LIMIT 1`);
        warehouse = { id: wh.warehouse_id, lat: Number(wh.latitude), lon: Number(wh.longitude) };

        const [{ vehicle_status_id }] = await dataSource.query(`SELECT vehicle_status_id FROM vehicle_statuses WHERE name = 'active'`);
        for (const i of [1, 2]) {
            const [{ vehicle_id }] = await dataSource.query(
                `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3)
                 VALUES ($1, 'camioneta', 'E2E pickups', $2, 1000, 50) RETURNING vehicle_id`,
                [vehicle_status_id, `PU${run}${i}`.slice(0, 15)],
            );
            scope.vehicleIds.add(vehicle_id);
        }

        for (const key of ['stop_service_minutes', 'planning_margin_pct']) {
            const [row] = await dataSource.query(`SELECT setting_value AS value FROM settings WHERE setting_key = $1`, [key]);
            originalSettings[key] = row?.value ?? '';
        }
        await putSetting('stop_service_minutes', '15');
        await putSetting('planning_margin_pct', '20');
    });

    afterAll(async () => {
        for (const [key, value] of Object.entries(originalSettings)) {
            await dataSource.query(`UPDATE settings SET setting_value = $1 WHERE setting_key = $2`, [value, key]);
        }
        const batchIds: number[] = (await dataSource.query(
            `SELECT DISTINCT route_batch_id AS id FROM dispatches WHERE source_order_ref LIKE $1 AND route_batch_id IS NOT NULL`,
            [`${refPrefix}%`],
        )).map((r: { id: number }) => r.id);
        await withEventPurge(dataSource, { dispatchRefs: [`${refPrefix}%`], routeBatchIds: batchIds, userNames: [`${userPrefix}%_${run}`] });
        await dataSource.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${refPrefix}%`]);
        if (batchIds.length) await dataSource.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
        await dataSource.query(`DELETE FROM vehicles WHERE vehicle_id = ANY($1::int[])`, [[...scope.vehicleIds]]);
        await dataSource.query(`DELETE FROM delivery_zones WHERE delivery_zone_id = $1`, [zoneId]);
        await dataSource.query(`DELETE FROM users WHERE username LIKE $1`, [`${userPrefix}%_${run}`]);
        await app?.close();
    });

    it('groups an undated pickup and a delivery in the same freshly created batch: the delivery moves to in_planning, the pickup stays pickup_scheduled', async () => {
        const deliveryId = await newDelivery(2);
        const pickupId = await newPickup(1, { preferredPickupDate: null });

        const res = await generate();

        expect(res.status).toBe(200);
        expect(res.body.summary.createdBatchIds).toHaveLength(1);
        const batchId = res.body.summary.createdBatchIds[0];

        const deliveryState = await stateOf(deliveryId);
        const pickupState = await stateOf(pickupId);
        expect(deliveryState).toMatchObject({ status: 'in_planning', route_batch_id: batchId });
        expect(pickupState).toMatchObject({ status: 'pickup_scheduled', route_batch_id: batchId });
        expect(pickupState.sequence_order).not.toBeNull();
        expect(pickupState.scheduled_window_start).not.toBeNull();

        // Only the delivery left an audit trail of a real status change; the pickup's status never changed.
        const [{ count }] = await dataSource.query(
            `SELECT COUNT(*)::int AS count FROM dispatch_events WHERE dispatch_id = $1 AND event_type = 'status_changed'`, [pickupId]);
        expect(count).toBe(0);
    });

    it("joins the open batch of its own zone and date when a later pickup's preferred date matches it, still pickup_scheduled", async () => {
        const [{ shift_date: shiftDate }] = await dataSource.query(
            `SELECT shift_date::text AS shift_date FROM route_batches WHERE delivery_zone_id = $1 AND status = 'provisional' LIMIT 1`, [zoneId],
        );
        const pickupId = await newPickup(3, { preferredPickupDate: shiftDate });

        const res = await generate();

        expect(res.status).toBe(200);
        expect(res.body.summary.createdBatchIds).toEqual([]);
        expect(res.body.summary.updatedBatchIds.length).toBeGreaterThan(0);
        const pickupState = await stateOf(pickupId);
        expect(pickupState.status).toBe('pickup_scheduled');
        expect(res.body.summary.updatedBatchIds).toContain(pickupState.route_batch_id);
    });
});
