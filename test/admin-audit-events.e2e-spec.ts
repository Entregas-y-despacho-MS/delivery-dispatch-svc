// RF-A35: audit trail of sensitive administrative actions, through the example handler
// PATCH /users/:id/role. Real AppModule against a real database; the users it creates are deleted in afterAll
// together with the audit rows of this run (found by their correlation id prefix).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { AdminAuditEventEntity } from '../src/modules/audit/admin-audit-events/entities/admin-audit-event.entity.js';

interface AuditRow {
    admin_audit_event_id: string;
    actor_user_id: number | null;
    actor_role: string | null;
    action: string;
    entity_type: string | null;
    entity_id: string | null;
    result: string;
    status_code: number | null;
    correlation_id: string;
    ip_address: string | null;
    metadata: Record<string, unknown>;
    occurred_at: Date;
}

describe('admin audit events (RF-A35)', () => {
    let app: INestApplication;
    let db: DataSource;
    let api: string;
    const run = Date.now().toString(36);
    const prefix = `e2e-audit-${run}`;
    const password = 'E2eAudit1234!';
    const ids: Record<'admin' | 'coordinator' | 'target', number> = { admin: 0, coordinator: 0, target: 0 };
    const tokens: Record<'admin' | 'coordinator', string> = { admin: '', coordinator: '' };
    const roles: Record<string, number> = {};
    let sequence = 0;
    const correlation = () => `${prefix}-${++sequence}`;

    const eventsOf = async (correlationId: string): Promise<AuditRow[]> =>
        await db.query('SELECT * FROM admin_audit_events WHERE correlation_id = $1', [correlationId]);
    const changeRole = (token: string | null, id: number, body: object, correlationId: string) => {
        const call = request(app.getHttpServer()).patch(`/${api}/users/${id}/role`).set('X-Request-Id', correlationId).send(body);
        return token ? call.set('Authorization', `Bearer ${token}`) : call;
    };

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

        for (const row of await db.query('SELECT role_id, name FROM roles')) roles[row.name] = row.role_id;
        const hash = await hashPassword(password);
        for (const [key, role] of [['admin', 'admin'], ['coordinator', 'coordinator'], ['target', 'driver']] as const) {
            const [{ user_id }] = await db.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false) RETURNING user_id`,
                [roles[role], `E2E audit ${key}`, `${prefix}-${key}`, hash],
            );
            ids[key] = user_id;
        }
        for (const key of ['admin', 'coordinator'] as const) {
            const res = await request(app.getHttpServer()).post(`/${api}/auth/login`).send({ username: `${prefix}-${key}`, password });
            tokens[key] = res.body.accessToken as string;
        }
    }, 30_000);

    afterAll(async () => {
        if (db?.isInitialized) {
            await db.query('DELETE FROM admin_audit_events WHERE correlation_id LIKE $1', [`${prefix}-%`]);
            await db.query('DELETE FROM users WHERE username LIKE $1', [`${prefix}-%`]);
        }
        await app?.close();
    });

    it('records an allowed action with actor, role, action, entity, result, time, correlation and allowed metadata', async () => {
        const correlationId = correlation();
        const before = Date.now();
        const res = await changeRole(tokens.admin, ids.target, { roleId: roles.supervisor }, correlationId);
        expect(res.status).toBe(200);
        expect(res.headers['x-request-id']).toBe(correlationId);

        const rows = await eventsOf(correlationId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            actor_user_id: ids.admin, actor_role: 'admin', action: 'user.role_changed', entity_type: 'user',
            entity_id: String(ids.target), result: 'success', status_code: 200, metadata: { roleId: roles.supervisor },
        });
        expect(new Date(rows[0]!.occurred_at).getTime()).toBeGreaterThanOrEqual(before - 1000);
        expect(rows[0]!.ip_address).toEqual(expect.any(String));
    });

    it('records a denied attempt by a role that is not allowed, without running the action', async () => {
        const roleOfTarget = async (): Promise<number> =>
            (await db.query('SELECT role_id FROM users WHERE user_id = $1', [ids.target]))[0].role_id;
        const before = await roleOfTarget();
        const correlationId = correlation();
        const res = await changeRole(tokens.coordinator, ids.target, { roleId: roles.admin }, correlationId);
        expect(res.status).toBe(403);
        expect(await eventsOf(correlationId)).toEqual([expect.objectContaining({
            actor_user_id: ids.coordinator, actor_role: 'coordinator', action: 'user.role_changed', entity_id: String(ids.target),
            result: 'denied', status_code: 403,
        })]);
        expect(await roleOfTarget()).toBe(before);
    });

    it('records the denial of an actor that must change its password first', async () => {
        await db.query('UPDATE users SET requires_pwd_change = true WHERE user_id = $1', [ids.admin]);
        try {
            const res = await request(app.getHttpServer()).post(`/${api}/auth/login`).send({ username: `${prefix}-admin`, password });
            const correlationId = correlation();
            const denied = await changeRole(res.body.accessToken as string, ids.target, { roleId: roles.driver }, correlationId);
            expect(denied.status).toBe(403);
            expect(denied.body.error).toBe('PASSWORD_CHANGE_REQUIRED');
            // The guard records without blocking the response: give the write a moment.
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(await eventsOf(correlationId)).toEqual([expect.objectContaining({
                actor_user_id: ids.admin, action: 'user.role_changed', result: 'denied', status_code: 403,
            })]);
        } finally {
            await db.query('UPDATE users SET requires_pwd_change = false WHERE user_id = $1', [ids.admin]);
        }
    });

    it('records an attempt without a valid token with no actor', async () => {
        const correlationId = correlation();
        const res = await changeRole('not-a-jwt', ids.target, { roleId: roles.admin }, correlationId);
        expect(res.status).toBe(401);
        expect(await eventsOf(correlationId)).toEqual([expect.objectContaining({
            actor_user_id: null, actor_role: null, result: 'denied', status_code: 401,
        })]);
    });

    it('records an attempt that the business rules reject as failed', async () => {
        const correlationId = correlation();
        const res = await changeRole(tokens.admin, ids.admin, { roleId: roles.driver }, correlationId);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('CANNOT_MODIFY_OWN_ACCOUNT');
        // A business 403 raised by the handler, not by the guard: the actor was allowed in, so it is a denial too.
        expect(await eventsOf(correlationId)).toEqual([expect.objectContaining({ actor_user_id: ids.admin, result: 'denied', status_code: 403 })]);

        const notFound = correlation();
        expect((await changeRole(tokens.admin, 999_999_999, { roleId: roles.driver }, notFound)).status).toBe(404);
        expect(await eventsOf(notFound)).toEqual([expect.objectContaining({ result: 'failed', status_code: 404, entity_id: '999999999' })]);
    });

    it('never stores secrets sent in the request', async () => {
        const correlationId = correlation();
        const res = await changeRole(tokens.admin, ids.target, { roleId: roles.driver, password: 'Leaked123!', token: 'eyJleak' }, correlationId);
        expect(res.status).toBe(400);
        const rows = await eventsOf(correlationId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ result: 'failed', status_code: 400 });
        expect(JSON.stringify(rows)).not.toMatch(/Leaked123!|eyJleak/);
    });

    it('generates a correlation id when the client sends none or a malformed one', async () => {
        const res = await request(app.getHttpServer()).get(`/${api}/health`).set('X-Request-Id', 'bad id with spaces');
        expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('matches the entity: same columns, types, lengths and nullability as the migration', async () => {
        const columns: Array<{ column_name: string; udt_name: string; character_maximum_length: number | null; is_nullable: 'YES' | 'NO' }> =
            await db.query(`SELECT column_name, udt_name, character_maximum_length, is_nullable FROM information_schema.columns WHERE table_name = 'admin_audit_events'`);
        const udt: Record<string, string> = { uuid: 'uuid', int: 'int4', varchar: 'varchar', smallint: 'int2', inet: 'inet', jsonb: 'jsonb', timestamptz: 'timestamptz' };
        const metadata = db.getMetadata(AdminAuditEventEntity);
        expect(metadata.columns.map((column) => column.databaseName).sort()).toEqual(columns.map((column) => column.column_name).sort());
        for (const column of metadata.columns) {
            const real = columns.find((candidate) => candidate.column_name === column.databaseName)!;
            expect({ column: column.databaseName, type: udt[String(column.type)], length: column.length ? Number(column.length) : null, nullable: column.isNullable })
                .toEqual({ column: real.column_name, type: real.udt_name, length: real.character_maximum_length, nullable: real.is_nullable === 'YES' });
        }
    });

    it('keeps the events of a user that is deleted, by the API or physically', async () => {
        const hash = await hashPassword(password);
        const [{ user_id: doomed }] = await db.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, 'E2E audit doomed', $2, $3, false) RETURNING user_id`,
            [roles.coordinator, `${prefix}-doomed`, hash],
        );
        const login = await request(app.getHttpServer()).post(`/${api}/auth/login`).send({ username: `${prefix}-doomed`, password });
        const correlationId = correlation();
        expect((await changeRole(login.body.accessToken as string, ids.target, { roleId: roles.admin }, correlationId)).status).toBe(403);

        const deleted = await request(app.getHttpServer()).delete(`/${api}/users/${doomed}`).set('Authorization', `Bearer ${tokens.admin}`);
        expect(deleted.status).toBeLessThan(300);
        await db.query('DELETE FROM users WHERE user_id = $1', [doomed]);

        expect(await eventsOf(correlationId)).toEqual([expect.objectContaining({ actor_user_id: doomed, actor_role: 'coordinator', result: 'denied' })]);
    });

    it('does not record handlers outside the catalog', async () => {
        const correlationId = correlation();
        await request(app.getHttpServer()).get(`/${api}/users/${ids.target}`).set('Authorization', `Bearer ${tokens.admin}`).set('X-Request-Id', correlationId);
        expect(await eventsOf(correlationId)).toEqual([]);
    });
});
