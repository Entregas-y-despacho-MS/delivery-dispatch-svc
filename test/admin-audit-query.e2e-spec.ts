// RF-A37 (ST-70.1): GET /audit/admin-events against the real AppModule and a real database.
// The events it searches are inserted by the test inside a window of 2020, where nothing else writes, and are deleted
// in afterAll together with the throwaway users (found by their prefix). It deletes rows of an append-only table, so
// run it against a disposable database (postgres:18-alpine), never a shared one.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';

type Who = 'admin' | 'coordinator' | 'supervisor' | 'driver' | 'root';
const WHO: Who[] = ['admin', 'coordinator', 'supervisor', 'driver', 'root'];

describe('admin audit search (RF-A37)', () => {
    let app: INestApplication;
    let db: DataSource;
    let api: string;
    const prefix = `e2e-auditq-${Date.now().toString(36)}`;
    const password = 'E2eAuditQ1234!';
    const ids = {} as Record<Who, number>;
    const tokens = {} as Record<Who, string>;

    // Window [2020-03-10T04:00Z, 2020-03-11T04:00Z) written with the Bolivia offset.
    const window = { from: '2020-03-10T00:00:00-04:00', to: '2020-03-11T00:00:00-04:00' };
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    // Expected ascending order: the boundary event first, then the three that share one instant (by id), then the rest.
    const ASC = [uuid(7), uuid(1), uuid(2), uuid(3), uuid(4), uuid(5), uuid(6)];

    const search = (who: Who | null, query: Record<string, string | number> = {}) => {
        const call = request(app.getHttpServer()).get(`/${api}/audit/admin-events`).query({ ...window, ...query });
        return who ? call.set('Authorization', `Bearer ${tokens[who]}`) : call;
    };
    const eventIds = (body: { data: Array<{ eventId: string }> }) => body.data.map((event) => event.eventId);

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        api = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(api);
        app.useGlobalPipes(new ValidationPipe({
            transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false },
        }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        db = moduleRef.get(DataSource);

        const roles: Record<string, number> = {};
        for (const row of await db.query('SELECT role_id, name FROM roles')) roles[row.name] = row.role_id;
        const hash = await hashPassword(password);
        for (const who of WHO) {
            const [{ user_id }] = await db.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false) RETURNING user_id`,
                [roles[who], `E2E audit query ${who}`, `${prefix}-${who}`, hash],
            );
            ids[who] = user_id;
            const res = await request(app.getHttpServer()).post(`/${api}/auth/login`).send({ username: `${prefix}-${who}`, password });
            tokens[who] = res.body.accessToken as string;
        }

        // [n, occurred_at, actor, role, action, entityType, entityId, result, status, ip, metadata]
        const events: Array<[number, string, number | null, string | null, string, string | null, string | null, string, number, string | null, object]> = [
            [1, '2020-03-10T10:00:00Z', ids.admin, 'admin', 'user.created', 'user', '501', 'success', 201, '10.1.2.3', { roleId: 3 }],
            [2, '2020-03-10T10:00:00Z', ids.admin, 'admin', 'user.updated', 'user', '501', 'success', 200, '10.1.2.3', {}],
            [3, '2020-03-10T10:00:00Z', ids.coordinator, 'coordinator', 'setting.updated', 'setting', 'k', 'denied', 403, '10.9.9.9', {}],
            [4, '2020-03-10T11:00:00Z', ids.coordinator, 'coordinator', 'catalog.changed', 'catalog', null, 'failed', 500, null, {}],
            [5, '2020-03-10T12:00:00Z', null, null, 'user.deleted', 'user', '502', 'denied', 401, null, {}],
            [6, '2020-03-10T13:00:00Z', ids.admin, 'admin', 'vehicle.changed', 'vehicle', '7', 'success', 200, null, {}],
            [7, '2020-03-10T04:00:00Z', ids.admin, 'admin', 'user.created', 'user', '503', 'success', 201, null, {}],
            // Exactly on 'to': outside the window.
            [8, '2020-03-11T04:00:00Z', ids.admin, 'admin', 'user.created', 'user', '504', 'success', 201, null, {}],
        ];
        for (const [n, at, actor, role, action, type, entityId, result, status, ip, metadata] of events) {
            await db.query(
                `INSERT INTO admin_audit_events (admin_audit_event_id, actor_user_id, actor_role, action, entity_type, entity_id, result, status_code, correlation_id, ip_address, metadata, occurred_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                [uuid(n), actor, role, action, type, entityId, result, status, `${prefix}-ev${n}`, ip, JSON.stringify(metadata), at],
            );
        }
    }, 60_000);

    afterAll(async () => {
        if (db?.isInitialized) {
            await db.query('DELETE FROM admin_audit_events WHERE correlation_id LIKE $1', [`${prefix}-%`]);
            await db.query('DELETE FROM admin_audit_events WHERE actor_user_id = ANY($1::int[]) OR admin_audit_event_id::text LIKE $2', [Object.values(ids), '00000000-0000-4000-8000-%']);
            await db.query('DELETE FROM users WHERE username LIKE $1', [`${prefix}-%`]);
        }
        await app?.close();
    });

    describe('authorization', () => {
        it('answers 401 without a token', async () => {
            const res = await search(null);
            expect(res.status).toBe(401);
            expect(res.body.data).toBeUndefined();
        });

        it.each(['coordinator', 'supervisor', 'driver'] as const)('answers 403 to the %s and returns no data', async (who) => {
            const res = await search(who);
            expect(res.status).toBe(403);
            expect(res.body).toMatchObject({ statusCode: 403, error: 'INSUFFICIENT_PERMISSIONS' });
            expect(res.body.data).toBeUndefined();
        });

        it('lets the administrator and root in', async () => {
            expect((await search('admin')).status).toBe(200);
            expect((await search('root')).status).toBe(200);
        });
    });

    describe('result and fields by role', () => {
        it('gives the administrator only the permitted fields', async () => {
            const res = await search('admin', { order: 'asc' });
            expect(res.status).toBe(200);
            expect(res.body.data[1]).toEqual({
                eventId: uuid(1), occurredAt: '2020-03-10T10:00:00.000Z', actorId: ids.admin, actorRole: 'admin', action: 'user.created',
                entityType: 'user', entityId: '501', result: 'success', statusCode: 201, correlationId: `${prefix}-ev1`,
            });
        });

        it('never gives the administrator the address or the metadata, in any row of the page', async () => {
            const res = await search('admin', { order: 'asc' });
            expect(res.body.data).toHaveLength(7);
            for (const event of res.body.data) {
                expect(event).not.toHaveProperty('ip');
                expect(event).not.toHaveProperty('metadata');
            }
        });

        it('shows the address and the metadata only to root, with null when the event has none', async () => {
            const res = await search('root', { order: 'asc' });
            expect(res.body.data[1]).toMatchObject({ eventId: uuid(1), ip: '10.1.2.3', metadata: { roleId: 3 } });
            expect(res.body.data[0]).toMatchObject({ eventId: uuid(7), ip: null, metadata: {} });
        });
    });

    describe('filters', () => {
        it('returns the whole window, half open: includes "from", excludes "to"', async () => {
            const res = await search('admin', { order: 'asc' });
            expect(eventIds(res.body)).toEqual(ASC);
            expect(res.body.meta).toEqual({ page: 1, limit: 10, total: 7, pages: 1 });
        });

        it('honours the offset of the window (the same instants written in UTC give the same result)', async () => {
            const res = await search('admin', { from: '2020-03-10T04:00:00Z', to: '2020-03-11T04:00:00Z', order: 'asc' });
            expect(eventIds(res.body)).toEqual(ASC);
            const shifted = await search('admin', { from: '2020-03-10T00:00:00Z', to: '2020-03-10T10:00:01Z', order: 'asc' });
            expect(eventIds(shifted.body)).toEqual([uuid(7), uuid(1), uuid(2), uuid(3)]);
        });

        it.each([
            [{ actorRole: 'coordinator' }, [uuid(3), uuid(4)]],
            [{ action: 'user.created' }, [uuid(7), uuid(1)]],
            [{ entityType: 'user' }, [uuid(7), uuid(1), uuid(2), uuid(5)]],
            [{ entityType: 'user', entityId: '501' }, [uuid(1), uuid(2)]],
            [{ result: 'denied' }, [uuid(3), uuid(5)]],
            [{ correlationId: 'CORRELATION' }, [uuid(4)]],
        ])('filters by %o', async (filter, expected) => {
            const query: Record<string, string | number> = { ...filter, order: 'asc' } as never;
            if (query.correlationId === 'CORRELATION') query.correlationId = `${prefix}-ev4`;
            const res = await search('admin', query);
            expect(res.status).toBe(200);
            expect(eventIds(res.body)).toEqual(expected);
        });

        it('filters by actor', async () => {
            const res = await search('admin', { actorId: ids.coordinator, order: 'asc' });
            expect(eventIds(res.body)).toEqual([uuid(3), uuid(4)]);
        });

        it('combines filters with AND', async () => {
            const both = await search('admin', { actorId: ids.admin, action: 'user.created', result: 'success', entityType: 'user' });
            expect(eventIds(both.body).sort()).toEqual([uuid(1), uuid(7)]);
            const none = await search('admin', { actorId: ids.coordinator, action: 'user.created' });
            expect(none.status).toBe(200);
            expect(none.body.data).toEqual([]);
        });
    });

    describe('order and pagination', () => {
        it('orders descending by default, with the id as tie-breaker', async () => {
            const res = await search('admin');
            expect(eventIds(res.body)).toEqual([...ASC].reverse());
        });

        it.each(['asc', 'desc'] as const)('walks every page in %s order without repeating or skipping rows', async (order) => {
            const seen: string[] = [];
            for (let page = 1; page <= 4; page += 1) {
                const res = await search('admin', { order, limit: 2, page });
                expect(res.status).toBe(200);
                expect(res.body.meta).toEqual({ page, limit: 2, total: 7, pages: 4 });
                seen.push(...eventIds(res.body));
            }
            expect(seen).toEqual(order === 'asc' ? ASC : [...ASC].reverse());
            expect((await search('admin', { order, limit: 2, page: 5 })).body.data).toEqual([]);
        });

        it('accepts a window of exactly 31 days and rejects one second more', async () => {
            const exact = await search('admin', { from: '2020-03-01T00:00:00Z', to: '2020-04-01T00:00:00Z' });
            expect(exact.status).toBe(200);
            const wider = await search('admin', { from: '2020-03-01T00:00:00Z', to: '2020-04-01T00:00:01Z' });
            expect(wider.status).toBe(400);
            expect(wider.body.error).toBe('INVALID_AUDIT_RANGE');
        });

        it('accepts the maximum limit and rejects one more', async () => {
            expect((await search('admin', { limit: 100 })).status).toBe(200);
            const res = await search('admin', { limit: 101 });
            expect(res.status).toBe(400);
            expect(res.body.message).toContain("The 'limit' parameter must be <= 100.");
        });
    });

    describe('empty result', () => {
        it('answers 200 with an empty list, distinct from an error', async () => {
            const res = await search('admin', { from: '2019-01-01T00:00:00Z', to: '2019-01-02T00:00:00Z' });
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ data: [], meta: { page: 1, limit: 10, total: 0, pages: 0 } });
        });
    });

    describe('invalid queries', () => {
        it.each([
            ['reversed window', { from: window.to, to: window.from }, 'INVALID_AUDIT_RANGE'],
            ['equal bounds', { to: window.from }, 'INVALID_AUDIT_RANGE'],
            ['window over 31 days', { from: '2020-01-01T00:00:00Z', to: '2020-02-02T00:00:00Z' }, 'INVALID_AUDIT_RANGE'],
            ['entityId without entityType', { entityId: '501' }, 'INVALID_AUDIT_FILTER'],
        ])('rejects %s with its own code', async (_name, query, code) => {
            const res = await search('admin', query);
            expect(res.status).toBe(400);
            expect(res.body.error).toBe(code);
        });

        it.each([
            ['no offset', { from: '2020-03-10T00:00:00' }],
            ['date only', { from: '2020-03-10' }],
            ['unknown action', { action: 'user.exploded' }],
            ['unknown role', { actorRole: 'boss' }],
            ['unknown result', { result: 'maybe' }],
            ['unknown parameter', { sort: 'x' }],
            ['bad correlation id', { correlationId: 'short' }],
        ])('rejects %s with a validation error', async (_name, query) => {
            const res = await search('admin', query);
            expect(res.status).toBe(400);
        });

        it('rejects a missing window', async () => {
            const res = await request(app.getHttpServer()).get(`/${api}/audit/admin-events`).set('Authorization', `Bearer ${tokens.admin}`);
            expect(res.status).toBe(400);
        });

        it('treats filter values as data, not SQL', async () => {
            const res = await search('admin', { entityType: 'user', entityId: "501'--" });
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual([]);
        });
    });
});
