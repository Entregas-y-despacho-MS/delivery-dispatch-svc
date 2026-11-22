// ST-302.1 — Real HTTP/PostgreSQL acceptance checks for GET /planning/pipeline (ES-302, Dashboard 2).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { todayInOperatingTimeZone } from '../src/modules/dispatch/dispatches/utils/operating-date.util.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

type Actor = 'coordinator' | 'supervisor' | 'driver' | 'admin' | 'root';

interface PipelineItem {
    dispatchId: number;
    stage: string;
    routeBatchId: number | null;
    shift: string | null;
    priority?: string;
    exception: { codes: string[]; reason: string } | null;
    detailPath: string;
}

// A past day no other suite writes on. Bolivia is UTC-4: 09:00 there is 13:00Z (morning), 14:00 there is 18:00Z (afternoon).
const DAY = '2020-06-15';
const MORNING = [`${DAY}T13:00:00Z`, `${DAY}T15:00:00Z`] as const;
const AFTERNOON = [`${DAY}T18:00:00Z`, `${DAY}T20:00:00Z`] as const;

describe('GET /planning/pipeline (e2e, ST-302.1)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const tokens: Record<Actor, string> = { coordinator: '', supervisor: '', driver: '', admin: '', root: '' };
    const run = Date.now().toString(36).toUpperCase();
    const prefix = `ST3021-${run}`;
    const ids = { zone: 0, otherZone: 0, edgeZone: 0, warehouse: 0, driver: 0, batches: [] as number[], vehicles: [] as number[], dispatch: {} as Record<string, number> };
    const statusIds: Record<string, number> = {};
    let deliveryTypeId = 0;
    let plateSeq = 0;

    const pipeline = (actor: Actor | null, query: Record<string, string | number | undefined>) => {
        const req = request(app.getHttpServer()).get(`/${apiPrefix}/planning/pipeline`).query(query);
        return actor ? req.set('Authorization', `Bearer ${tokens[actor]}`) : req;
    };
    const view = (query: Record<string, string | number | undefined> = {}) => pipeline('coordinator', { date: DAY, zoneId: ids.zone, ...query });
    const byKey = (items: PipelineItem[], key: string) => items.find((item) => item.dispatchId === ids.dispatch[key])!;

    const createVehicle = async (capacityKg: number, capacityM3: number, options: { maxLengthCm?: number; deleted?: boolean } = {}): Promise<number> => {
        const [{ vehicle_status_id: statusId }] = await dataSource.query(`SELECT vehicle_status_id FROM vehicle_statuses WHERE name = 'active'`);
        const [{ vehicle_id: id }] = await dataSource.query(
            `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3, max_package_length_cm, deleted_at)
             VALUES ($1, 'camioneta', 'E2E ST-302.1', $2, $3, $4, $5, $6) RETURNING vehicle_id`,
            [statusId, `P${run}${++plateSeq}`.slice(0, 15), capacityKg, capacityM3, options.maxLengthCm ?? null, options.deleted ? new Date() : null],
        );
        ids.vehicles.push(id);
        return id;
    };
    const createBatch = async (status: string, vehicleId: number | null, driverId: number | null = null, zoneId: number = ids.zone): Promise<number> => {
        const [{ route_batch_id: id }] = await dataSource.query(
            `INSERT INTO route_batches (shift_date, status, vehicle_id, driver_id, delivery_zone_id) VALUES ($1, $2, $3, $4, $5) RETURNING route_batch_id`,
            [DAY, status, vehicleId, driverId, zoneId],
        );
        ids.batches.push(id);
        return id;
    };
    const createDispatch = async (
        key: string,
        status: string,
        options: { batchId?: number; zoneId?: number | null; warehouseId?: number; window?: readonly [string, string]; priority?: string; pkg?: { l: number; w: number; h: number; kg: number } } = {},
    ): Promise<number> => {
        const [{ dispatch_id: id }] = await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, delivery_zone_id, route_batch_id, source_order_ref, delivery_address, scheduled_window_start, scheduled_window_end, priority, origin_warehouse_id)
             VALUES ($1, $2, $3, $4, $5, 'Dirección E2E ST-302.1', $6, $7, $8, $9) RETURNING dispatch_id`,
            [
                deliveryTypeId, statusIds[status], options.zoneId === undefined ? ids.zone : options.zoneId, options.batchId ?? null, `${prefix}-${key}`,
                options.window?.[0] ?? null, options.window?.[1] ?? null, options.priority ?? 'normal', options.warehouseId ?? null,
            ],
        );
        ids.dispatch[key] = id;
        if (options.pkg) {
            await dataSource.query(
                `INSERT INTO dispatch_packages (dispatch_id, external_package_id, length_cm, width_cm, height_cm, gross_weight_kg) VALUES ($1, $2, $3, $4, $5, $6)`,
                [id, `${prefix}-${key}-PKG`, options.pkg.l, options.pkg.w, options.pkg.h, options.pkg.kg],
            );
        }
        return id;
    };

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        apiPrefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(apiPrefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        dataSource = moduleRef.get(DataSource);

        const passwordHash = await hashPassword('E2eTest1234');
        const createUser = async (roleName: string, fullName: string, username: string): Promise<number> => {
            const [{ role_id: roleId }] = await dataSource.query(`SELECT role_id FROM roles WHERE name = $1`, [roleName]);
            const [{ user_id: userId }] = await dataSource.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false) RETURNING user_id`,
                [roleId, fullName, username, passwordHash],
            );
            return userId;
        };
        for (const actor of ['coordinator', 'supervisor', 'driver', 'admin', 'root'] as const) {
            await createUser(actor, `ST-302.1 ${actor} ${run}`, `e2e_st3021_${actor}_${run}`);
            const login = await request(app.getHttpServer()).post(`/${apiPrefix}/auth/login`).send({ username: `e2e_st3021_${actor}_${run}`, password: 'E2eTest1234' });
            expect(login.status, `login ${actor}`).toBe(200);
            tokens[actor] = login.body.accessToken as string;
        }
        ids.driver = await createUser('driver', `ST-302.1 route driver ${run}`, `e2e_st3021_route_${run}`);

        for (const [key, letter] of [['zone', 'A'], ['otherZone', 'B'], ['edgeZone', 'C']] as const) {
            const [{ delivery_zone_id: id }] = await dataSource.query(
                `INSERT INTO delivery_zones (code, name, estimated_time_min) VALUES ($1, $2, 60) RETURNING delivery_zone_id`, [`Z3021${run}${letter}`, `E2E3021 ${run} ${key}`]);
            ids[key] = id;
        }
        [{ warehouse_id: ids.warehouse }] = await dataSource.query(
            `INSERT INTO warehouses (code, name, address, latitude, longitude, reception_start_time, reception_end_time) VALUES ($1, $2, 'Av. E2E', -16.5, -68.1, '08:00', '18:00') RETURNING warehouse_id`,
            [`W3021${run}`, `E2E3021 hub ${run}`],
        );
        for (const row of await dataSource.query(`SELECT dispatch_status_id, name FROM dispatch_statuses`)) statusIds[row.name] = row.dispatch_status_id;
        [{ dispatch_type_id: deliveryTypeId }] = await dataSource.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);

        // B1: provisional, a big vehicle, three dispatches (two in the pipeline, one already delivered) that fit.
        const small = { l: 40, w: 30, h: 25, kg: 6.4 };
        const b1 = await createBatch('provisional', await createVehicle(1000, 50));
        await createDispatch('b1-scheduled', 'scheduled', { batchId: b1, pkg: small });
        await createDispatch('b1-planning', 'in_planning', { batchId: b1, pkg: small });
        await createDispatch('b1-delivered', 'delivered', { batchId: b1, pkg: small });
        // B2: provisional, the weight (155 kg) exceeds 100 kg but the volume fits.
        const b2 = await createBatch('provisional', await createVehicle(100, 10));
        await createDispatch('b2-heavy', 'scheduled', { batchId: b2, pkg: { l: 10, w: 10, h: 10, kg: 150 } });
        await createDispatch('b2-light', 'scheduled', { batchId: b2, pkg: { l: 10, w: 10, h: 10, kg: 5 } });
        // B3: provisional, the volume (1 m³) exceeds 0.5 m³ but the weight fits.
        const b3 = await createBatch('provisional', await createVehicle(1000, 0.5));
        await createDispatch('b3-bulky', 'scheduled', { batchId: b3, pkg: { l: 100, w: 100, h: 100, kg: 10 } });
        // B4: confirmed with driver; B5: in execution.
        const b4 = await createBatch('confirmed', await createVehicle(1000, 50), ids.driver);
        await createDispatch('b4-assigned', 'assigned', { batchId: b4, pkg: small });
        const b5 = await createBatch('in_execution', await createVehicle(1000, 50));
        await createDispatch('b5-transit', 'in_transit', { batchId: b5, pkg: small });
        await createDispatch('b5-out', 'out_for_delivery', { batchId: b5, pkg: small });
        // B6: provisional without vehicle.
        const b6 = await createBatch('provisional', null);
        await createDispatch('b6-planning', 'in_planning', { batchId: b6 });
        // Unbatched: two ready (one urgent), one with a plan exception, one in address review, one of another zone, one without window.
        await createDispatch('ready-morning', 'pending', { window: MORNING });
        await createDispatch('ready-afternoon', 'pending', { window: AFTERNOON, priority: 'urgent' });
        const noFit = await createDispatch('no-vehicle', 'pending', { window: AFTERNOON });
        await dataSource.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, detail, actor_type, reason, metadata) VALUES ($1, 'plan_exception', 'The order could not be planned.', 'system', 'no_vehicle_fits', '{}'::jsonb)`,
            [noFit],
        );
        await createDispatch('address', 'address_review', { window: AFTERNOON });
        await createDispatch('other-zone', 'pending', { window: MORNING, zoneId: ids.otherZone });
        await createDispatch('carry-over', 'pending');

        // ── Edge cases, in their own zone so the counts above stay exact ──
        const edge = ids.edgeZone;
        const heavyAndBulky = { l: 100, w: 100, h: 100, kg: 50 }; // 1 m³ and 50 kg
        const eb1 = await createBatch('pending_final_review', await createVehicle(1000, 50), null, edge);
        await createDispatch('e-final-review', 'scheduled', { batchId: eb1, zoneId: edge, pkg: small });
        await createDispatch('e-pickup-batch', 'pickup_scheduled', { batchId: eb1, zoneId: edge, pkg: small });
        await createDispatch('e-pickup-free', 'pickup_scheduled', { zoneId: edge, window: MORNING });
        await createDispatch('e-resched', 'rescheduled', { zoneId: edge, window: MORNING });
        const eb2 = await createBatch('closed', null, null, edge);
        await createDispatch('e-closed', 'assigned', { batchId: eb2, zoneId: edge });
        const eb3 = await createBatch('provisional', null, null, edge);
        await createDispatch('e-pending-in-batch', 'pending', { batchId: eb3, zoneId: edge });
        const eb4 = await createBatch('confirmed', await createVehicle(10, 0.5), null, edge);
        await createDispatch('e-confirmed-over', 'assigned', { batchId: eb4, zoneId: edge, pkg: heavyAndBulky });
        const eb5 = await createBatch('in_execution', await createVehicle(10, 0.5), null, edge);
        await createDispatch('e-exec-over', 'in_transit', { batchId: eb5, zoneId: edge, pkg: heavyAndBulky });
        const eb6 = await createBatch('provisional', await createVehicle(1000, 50, { maxLengthCm: 10 }), null, edge);
        await createDispatch('e-dims', 'scheduled', { batchId: eb6, zoneId: edge, pkg: { l: 20, w: 5, h: 5, kg: 1 } });
        const eb7 = await createBatch('provisional', await createVehicle(1000, 50, { deleted: true }), null, edge);
        await createDispatch('e-deleted-vehicle', 'scheduled', { batchId: eb7, zoneId: edge, pkg: small });
        const stale = await createDispatch('e-stale', 'pending', { zoneId: edge, window: MORNING });
        for (const event of ['plan_exception', 'status_changed']) {
            await dataSource.query(
                `INSERT INTO dispatch_events (dispatch_id, event_type, detail, actor_type, reason, metadata) VALUES ($1, $2, 'E2E', 'system', $3, '{}'::jsonb)`,
                [stale, event, event === 'plan_exception' ? 'no_vehicle_available' : null],
            );
        }
        // Shift edge: 11:59 and 12:00 in La Paz are 15:59Z and 16:00Z.
        await createDispatch('e-1159', 'pending', { zoneId: edge, window: [`${DAY}T15:59:00Z`, `${DAY}T17:59:00Z`] });
        await createDispatch('e-1200', 'pending', { zoneId: edge, window: [`${DAY}T16:00:00Z`, `${DAY}T18:00:00Z`] });
        await createDispatch('e-warehouse', 'pending', { zoneId: edge, warehouseId: ids.warehouse, window: AFTERNOON });
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) {
            await withEventPurge(dataSource, { dispatchRefs: [`${prefix}%`], routeBatchIds: ids.batches, userNames: [`e2e_st3021_%_${run}`] }, async (manager) => {
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${prefix}%`]);
                await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [ids.batches]);
                await manager.query(`DELETE FROM vehicles WHERE vehicle_id = ANY($1::int[])`, [ids.vehicles]);
                await manager.query(`DELETE FROM delivery_zones WHERE code LIKE $1`, [`Z3021${run}%`]);
                await manager.query(`DELETE FROM warehouses WHERE warehouse_id = $1`, [ids.warehouse]);
                await manager.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_st3021_%_${run}`]);
            });
        }
        await app?.close();
    });

    describe('access', () => {
        it('needs a token, and is for the coordinator only', async () => {
            expect((await pipeline(null, { date: DAY })).status).toBe(401);
            for (const actor of ['supervisor', 'driver', 'admin'] as const) {
                const response = await pipeline(actor, { date: DAY });
                expect(response.status, actor).toBe(403);
                expect(response.body.error).toBe('INSUFFICIENT_PERMISSIONS');
            }
            expect((await view()).status).toBe(200);
            expect((await pipeline('root', { date: DAY, zoneId: ids.zone })).status).toBe(200);
        });

        it('rejects invalid filters with 400', async () => {
            for (const query of [{ date: '15/06/2020' }, { date: '2020-02-30' }, { shift: 'night' }, { stage: 'done' }, { zoneId: 0 }, { warehouseId: 'abc' }, { limit: 101 }, { page: 0 }, { page: 1_000_001 }]) {
                const response = await pipeline('coordinator', query);
                expect(response.status, JSON.stringify(query)).toBe(400);
            }
        });
    });

    describe('stages: each dispatch in one, counted by dispatch', () => {
        it('counts every stage by dispatch and leaves the batch as detail only', async () => {
            const { body, status } = await view({ limit: 100 });
            expect(status).toBe(200);
            expect(body.date).toBe(DAY);
            expect(body.summary).toEqual({
                byStage: { ready_unbatched: 2, provisional_review: 3, confirmed_assigned: 1, in_execution: 2, exception: 5 },
                total: 13,
            });
            const items = body.data as PipelineItem[];
            expect(items).toHaveLength(13);
            expect(new Set(items.map((item) => item.dispatchId)).size).toBe(13);
            const stageOf = (key: string) => byKey(items, key).stage;
            expect(['ready-morning', 'ready-afternoon'].map(stageOf)).toEqual(['ready_unbatched', 'ready_unbatched']);
            expect(['b1-scheduled', 'b1-planning', 'b6-planning'].map(stageOf)).toEqual(['provisional_review', 'provisional_review', 'provisional_review']);
            expect(stageOf('b4-assigned')).toBe('confirmed_assigned');
            expect(['b5-transit', 'b5-out'].map(stageOf)).toEqual(['in_execution', 'in_execution']);
            // Finished dispatches, other zones and other days are not part of the view.
            expect(items.find((item) => item.dispatchId === ids.dispatch['b1-delivered'])).toBeUndefined();
            expect(items.find((item) => item.dispatchId === ids.dispatch['other-zone'])).toBeUndefined();
            expect(items.find((item) => item.dispatchId === ids.dispatch['carry-over'])).toBeUndefined();
        });

        it('shows a batch of three dispatches as one detail row while only two of them are counted', async () => {
            const { body } = await view({ limit: 100 });
            const b1 = body.batches.find((batch: { id: number }) => batch.id === ids.batches[0]);
            expect(b1).toMatchObject({ status: 'provisional', dispatchCount: 3 });
            expect(body.summary.byStage.provisional_review).toBe(3); // b1-scheduled, b1-planning and b6-planning, never the batch
        });

        it('lists the urgent dispatch first', async () => {
            const { body } = await view({ limit: 100 });
            expect(body.data[0].dispatchId).toBe(ids.dispatch['ready-afternoon']);
        });

        it('gives the batch of a dispatch its vehicle, driver and status as detail', async () => {
            const { body } = await view({ limit: 100 });
            const item = byKey(body.data, 'b4-assigned') as PipelineItem & { vehicle: { name: string } | null; driver: { name: string } | null };
            expect(item.routeBatchId).toBe(ids.batches[3]);
            expect(item.vehicle?.name).toMatch(new RegExp(`^P${run}`));
            expect(item.driver?.name).toBe(`ST-302.1 route driver ${run}`);
            expect(body.batches.find((batch: { id: number }) => batch.id === ids.batches[3])).toMatchObject({ status: 'confirmed' });
        });
    });

    describe('capacity: kg and m³ apart', () => {
        it('flags the kg excess without a volume excess, and the opposite, with their own codes', async () => {
            const { body } = await view({ limit: 100 });
            const [b2, b3] = [ids.batches[1], ids.batches[2]].map((id) => body.batches.find((batch: { id: number }) => batch.id === id));

            expect(b2.capacity.weight).toMatchObject({ unit: 'kg', actual: 155, capacity: 100, excess: 55, exceeded: true });
            expect(b2.capacity.volume).toMatchObject({ unit: 'm3', exceeded: false, excess: 0 });
            expect(b3.capacity.volume).toMatchObject({ unit: 'm3', actual: 1, capacity: 0.5, excess: 0.5, exceeded: true });
            expect(b3.capacity.weight).toMatchObject({ unit: 'kg', actual: 10, exceeded: false });

            expect(byKey(body.data, 'b2-heavy').exception?.codes).toEqual(['capacity_exceeded_kg']);
            expect(byKey(body.data, 'b2-light').exception?.codes).toEqual(['capacity_exceeded_kg']);
            expect(byKey(body.data, 'b3-bulky').exception?.codes).toEqual(['capacity_exceeded_m3']);
            expect(byKey(body.data, 'b3-bulky').exception?.reason).toContain('(m³)');
        });

        it('never builds a combined percentage: only the weight and the volume carry one each', async () => {
            const { body } = await view({ limit: 100 });
            const capacity = body.batches.find((batch: { id: number }) => batch.id === ids.batches[1]).capacity;
            expect(Object.keys(capacity).sort()).toEqual(['dimensionViolationCount', 'volume', 'weight']);
            expect(capacity.weight.usedPercent).toBeCloseTo(155, 1);
            expect(capacity.volume.usedPercent).toBeLessThan(1);
        });

        it('does not invent a capacity for a batch without vehicle', async () => {
            const { body } = await view({ limit: 100 });
            expect(body.batches.find((batch: { id: number }) => batch.id === ids.batches[5]).capacity).toBeNull();
            expect(byKey(body.data, 'b6-planning').exception).toBeNull();
        });
    });

    describe('exceptions', () => {
        it('lists the plan exception and the address review with their code, reason and the path to solve them', async () => {
            const { body } = await view({ stage: 'exception', limit: 100 });
            const items = body.data as PipelineItem[];
            expect(items).toHaveLength(5);
            expect(byKey(items, 'no-vehicle').exception).toEqual({ codes: ['no_vehicle_fits'], reason: 'No vehicle has the capacity for this dispatch.' });
            expect(byKey(items, 'address').exception?.codes).toEqual(['address_invalid']);
            expect(byKey(items, 'address').detailPath).toBe(`/dispatches/${ids.dispatch['address']}/detail`);
        });

        it('keeps the summary of every stage when the list is filtered by one', async () => {
            const { body } = await view({ stage: 'exception' });
            expect(body.summary.total).toBe(13);
            expect(body.meta.total).toBe(5);
        });

        it('stops reporting a plan exception once the dispatch left pending', async () => {
            // The generator planned it into the provisional batch B1 after the coordinator solved the exception.
            await dataSource.query(`UPDATE dispatches SET dispatch_status_id = $1, route_batch_id = $2 WHERE dispatch_id = $3`, [statusIds['in_planning'], ids.batches[0], ids.dispatch['no-vehicle']]);
            try {
                const { body } = await view({ limit: 100 });
                expect(byKey(body.data, 'no-vehicle')).toMatchObject({ stage: 'provisional_review', exception: null });
            } finally {
                await dataSource.query(`UPDATE dispatches SET dispatch_status_id = $1, route_batch_id = NULL WHERE dispatch_id = $2`, [statusIds['pending'], ids.dispatch['no-vehicle']]);
            }
        });
    });

    describe('filters and pagination', () => {
        it('filters by shift from the window start', async () => {
            const morning = await view({ shift: 'morning', limit: 100 });
            expect(morning.body.data.map((item: PipelineItem) => item.dispatchId)).toEqual([ids.dispatch['ready-morning']]);
            const afternoon = await view({ shift: 'afternoon', limit: 100 });
            expect(afternoon.body.data.map((item: PipelineItem) => item.dispatchId).sort()).toEqual([ids.dispatch['ready-afternoon'], ids.dispatch['no-vehicle'], ids.dispatch['address']].sort());
        });

        it('filters by zone: another zone only sees its own dispatch', async () => {
            const { body } = await pipeline('coordinator', { date: DAY, zoneId: ids.otherZone });
            expect(body.data.map((item: PipelineItem) => item.dispatchId)).toEqual([ids.dispatch['other-zone']]);
        });

        it('carries over an open dispatch without batch or window to the days after its creation', async () => {
            const { body } = await pipeline('coordinator', { date: todayInOperatingTimeZone(), zoneId: ids.zone });
            expect(body.data.map((item: PipelineItem) => item.dispatchId)).toEqual([ids.dispatch['carry-over']]);
            expect(body.data[0].stage).toBe('ready_unbatched');
            const yesterday = new Date(Date.parse(`${todayInOperatingTimeZone()}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
            expect((await pipeline('coordinator', { date: yesterday, zoneId: ids.zone })).body.data).toEqual([]);
        });

        it('paginates the dispatches without losing the total', async () => {
            const first = await view({ page: 1, limit: 5 });
            const third = await view({ page: 3, limit: 5 });
            expect(first.body.data).toHaveLength(5);
            expect(third.body.data).toHaveLength(3);
            expect(first.body.meta).toEqual({ page: 1, limit: 5, total: 13, pages: 3 });
            expect(first.body.summary.total).toBe(13);
        });

        it('answers a day without dispatches with zeros', async () => {
            const { body, status } = await pipeline('coordinator', { date: '2020-06-14', zoneId: ids.zone });
            expect(status).toBe(200);
            expect(body.summary.total).toBe(0);
            expect(body.data).toEqual([]);
            expect(body.batches).toEqual([]);
        });
    });
    describe('edge cases', () => {
        const edgeView = (query: Record<string, string | number | undefined> = {}) => pipeline('coordinator', { date: DAY, zoneId: ids.edgeZone, limit: 100, ...query });
        const stageOf = (items: PipelineItem[], key: string) => byKey(items, key).stage;

        it('counts the stages of the edge zone', async () => {
            const { body } = await edgeView();
            expect(body.summary).toEqual({
                byStage: { ready_unbatched: 6, provisional_review: 3, confirmed_assigned: 0, in_execution: 1, exception: 4 },
                total: 14,
            });
        });

        it('keeps a pickup inside a batch in the stage of its batch, and a batch in final review as review', async () => {
            const { body } = await edgeView();
            expect(stageOf(body.data, 'e-final-review')).toBe('provisional_review');
            expect(stageOf(body.data, 'e-pickup-batch')).toBe('provisional_review');
        });

        it('treats a pickup and a rescheduled delivery without batch as ready', async () => {
            const { body } = await edgeView();
            expect(stageOf(body.data, 'e-pickup-free')).toBe('ready_unbatched');
            expect(stageOf(body.data, 'e-resched')).toBe('ready_unbatched');
        });

        it('flags a closed batch with an active dispatch, and a pending dispatch inside a batch, as inconsistent', async () => {
            const { body } = await edgeView();
            expect(byKey(body.data, 'e-closed').exception?.codes).toEqual(['inconsistent_state']);
            expect(byKey(body.data, 'e-pending-in-batch').exception?.codes).toEqual(['inconsistent_state']);
        });

        it('flags kg and m3 together with both codes in a confirmed batch, but not a batch already in execution', async () => {
            const { body } = await edgeView();
            expect(byKey(body.data, 'e-confirmed-over')).toMatchObject({ stage: 'exception', exception: { codes: ['capacity_exceeded_kg', 'capacity_exceeded_m3'] } });
            expect(byKey(body.data, 'e-exec-over')).toMatchObject({ stage: 'in_execution', exception: null });
            const executing = body.batches.find((batch: { id: number }) => batch.id === byKey(body.data, 'e-exec-over').routeBatchId);
            expect(executing.capacity.weight.exceeded).toBe(true); // the load is still reported, it is just not an exception anymore
        });

        it('flags a package longer than the vehicle accepts', async () => {
            const { body } = await edgeView();
            expect(byKey(body.data, 'e-dims').exception?.codes).toEqual(['package_dimensions_exceeded']);
            const batch = body.batches.find((item: { id: number }) => item.id === byKey(body.data, 'e-dims').routeBatchId);
            expect(batch.capacity.dimensionViolationCount).toBe(1);
        });

        it('shows no vehicle and no capacity when the vehicle of the batch was deleted', async () => {
            const { body } = await edgeView();
            const item = byKey(body.data, 'e-deleted-vehicle') as PipelineItem & { vehicle: unknown };
            expect(item).toMatchObject({ stage: 'provisional_review', vehicle: null });
            expect(body.batches.find((batch: { id: number }) => batch.id === item.routeBatchId).capacity).toBeNull();
        });

        it('does not report a plan exception that a later status change closed', async () => {
            const { body } = await edgeView();
            expect(byKey(body.data, 'e-stale')).toMatchObject({ stage: 'ready_unbatched', exception: null });
        });

        it('splits the shift at 12:00 La Paz: 11:59 is morning and 12:00 is afternoon', async () => {
            const { body } = await edgeView();
            expect(byKey(body.data, 'e-1159').shift).toBe('morning');
            expect(byKey(body.data, 'e-1200').shift).toBe('afternoon');
        });

        it('filters by origin warehouse', async () => {
            const { body } = await edgeView({ warehouseId: ids.warehouse });
            expect(body.data.map((item: PipelineItem) => item.dispatchId)).toEqual([ids.dispatch['e-warehouse']]);
            expect(body.data[0].warehouse).toEqual({ id: ids.warehouse, name: `E2E3021 hub ${run}` });
        });
    });
});
