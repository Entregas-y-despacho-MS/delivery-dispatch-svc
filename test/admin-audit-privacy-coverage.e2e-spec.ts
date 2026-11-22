// RF-A35 / ST-68.3: coverage and privacy of the administrative audit trail, checked against the original request.
//   - Every endpoint of ADMIN_AUDIT_CATALOG is called twice: with no token (no actor) and with the token of an
//     account that must change its password first (an actor that is denied). Each call must leave exactly one row
//     whose actor, role, action, entity, result, status, time and correlation match the request that was sent, whose
//     metadata only holds what the action allows, and that never stores the secrets or personal data of the body.
//   - IP: a forged X-Forwarded-For is ignored unless the hop that sends it is a trusted proxy (TRUST_PROXY).
//   - A failed audit write does not change the business result, and is logged as an error with the whole event and
//     no secrets, instead of being lost silently.
import { Logger, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService } from '@nestjs/core';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AUDIT_ACTION_KEY, type AuditActionMetadata } from '../src/modules/audit/admin-audit-events/decorators/audit-action.decorator.js';
import { ADMIN_AUDIT_CATALOG, type AuditActionName } from '../src/modules/audit/admin-audit-events/domain/admin-audit-catalog.js';
import { parseTrustProxy } from '../src/config/helpers/trust-proxy.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { AuditE2eHarness, type AuditRow } from './helpers/audit-e2e.harness.js';

// The two sweeps send about 80 requests from one IP within a minute; the global limit (100/min) would answer
// 429 before the guards. The factory reads this when the app is compiled in `beforeAll`.
process.env.THROTTLE_LIMIT ??= '1000';

type Verb = 'get' | 'post' | 'put' | 'patch' | 'delete';
type FullRow = AuditRow & { ip_address: string | null; occurred_at: Date; actor_role: string | null };

interface CataloguedEndpoint {
    action: AuditActionName;
    endpoint: string;
    verb: Verb;
    path: string;
    params: Record<string, string>;
    declared: AuditActionMetadata;
}

/** Values every request sends in its body: none of them may reach the audit row. */
const SECRETS = {
    password: 'Sw33p-Pass!word', currentPassword: 'Sw33p-Current!', newPassword: 'Sw33p-New!pass', token: 'sweep-token-value',
    accessToken: 'eyJsweep.access.token', refreshToken: 'eyJsweep.refresh.token', secret: 'SWEEPSECRETBASE32', signature: 'data:image/png;base64,c3dlZXA=',
    totpCode: '135790', otp: '864209', resetToken: 'sweep-reset-token', email: 'sweep.person@example.test', phone: '+591 79999999',
    contactPhone: '+591 78888888', address: 'Av. Barrido 742', fullName: 'Persona Barrido',
};
const FORGED_IP = '203.0.113.66';
const PARAM_VALUES: Record<string, string> = { id: '987654321', key: 'e2e_sweep_key' };
const LOOPBACK = ['127.0.0.1', '::1'];

const join = (...parts: unknown[]): string =>
    '/' + parts.flatMap((part) => (Array.isArray(part) ? part : [part])).map((part) => String(part ?? '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

/** The entity id the row must carry for this request, from the action's own declaration. */
function expectedEntityId(item: CataloguedEndpoint, actorId: number | null): string | null {
    switch (item.declared.entityIdFrom ?? 'param') {
        case 'actor': return actorId === null ? null : String(actorId);
        case 'response': return null; // a rejected request has no response body with an id
        default: {
            const name = item.declared.entityIdParam === undefined ? 'id' : item.declared.entityIdParam;
            return name ? (item.params[name] ?? null) : null;
        }
    }
}

describe('admin audit coverage and privacy (ST-68.3)', () => {
    const h = new AuditE2eHarness('audit-privacy');
    let catalogued: CataloguedEndpoint[] = [];
    let mustChange: { id: number; token: string };
    const express = () => h.app.getHttpAdapter().getInstance() as { set: (name: string, value: unknown) => void };

    const rowsOf = async (correlationId: string) =>
        (await h.db.query('SELECT * FROM admin_audit_events WHERE correlation_id = $1', [correlationId])) as FullRow[];

    /** Sends the request with a chosen correlation id and the forged header, and reads its single row. */
    const send = async (item: CataloguedEndpoint, token: string | null, correlationId: string) => {
        const before = Date.now();
        let call = request(h.app.getHttpServer())[item.verb](`/${h.api}${item.path}`)
            .set('X-Request-Id', correlationId).set('X-Forwarded-For', FORGED_IP);
        if (token) call = call.set('Authorization', `Bearer ${token}`);
        // `undeclaredNote` is harmless but no action allows it: it must not reach the row either.
        const response = await call.send({ ...SECRETS, undeclaredNote: 'not-in-any-allow-list' });
        const after = Date.now();
        // The guards record a denial without awaiting it (they stay synchronous), so the row may land just after
        // the response: wait for it, then a little more, so a second row would show up too.
        let rows = await rowsOf(correlationId);
        for (let waited = 0; rows.length === 0 && waited < 3_000; waited += 50) {
            await new Promise((done) => setTimeout(done, 50));
            rows = await rowsOf(correlationId);
        }
        if (rows.length > 0) {
            await new Promise((done) => setTimeout(done, 100));
            rows = await rowsOf(correlationId);
        }
        return { response, before, after, rows };
    };

    const expectPrivateMetadata = (item: CataloguedEndpoint, row: FullRow) => {
        const allowed = new Set([...(item.declared.bodyFields ?? []), ...Object.keys(item.declared.metadata ?? {})]);
        for (const key of Object.keys(row.metadata)) expect(allowed.has(key), `${item.endpoint} stored ${key}`).toBe(true);
        const stored = JSON.stringify(row);
        for (const value of Object.values(SECRETS)) expect(stored, `${item.endpoint} stored a secret`).not.toContain(value);
    };

    const expectMatchesRequest = (
        item: CataloguedEndpoint,
        sent: Awaited<ReturnType<typeof send>>,
        correlationId: string,
        actor: { id: number; role: string } | null,
        status: number,
    ) => {
        expect(sent.response.status, item.endpoint).toBe(status);
        expect(sent.rows, `${item.endpoint}: one row per request`).toHaveLength(1);
        const row = sent.rows[0]!;
        expect(row, item.endpoint).toMatchObject({
            actor_user_id: actor?.id ?? null, actor_role: actor?.role ?? null, action: item.action,
            entity_type: ADMIN_AUDIT_CATALOG[item.action].entityType, entity_id: expectedEntityId(item, actor?.id ?? null),
            result: 'denied', status_code: status, correlation_id: correlationId,
        });
        // The time of the event is the time of the request, not of a late write.
        const occurred = new Date(row.occurred_at).getTime();
        expect(occurred, item.endpoint).toBeGreaterThanOrEqual(sent.before - 1_000);
        expect(occurred, item.endpoint).toBeLessThanOrEqual(sent.after + 1_000);
        // No TRUST_PROXY: the forged header is ignored and the socket address is stored.
        expect(LOOPBACK, `${item.endpoint} ip ${row.ip_address}`).toContain(row.ip_address);
        expectPrivateMetadata(item, row);
    };

    beforeAll(async () => {
        await h.start(['admin']);
        express().set('trust proxy', false);

        const handlers = new Map<string, AuditActionMetadata>();
        for (const { metatype } of h.app.get(DiscoveryService).getControllers()) {
            if (!metatype) continue;
            const base = Reflect.getMetadata(PATH_METADATA, metatype) as string | string[] | undefined;
            for (const name of Object.getOwnPropertyNames(metatype.prototype)) {
                const handler = metatype.prototype[name] as unknown;
                if (typeof handler !== 'function') continue;
                const verb = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
                const declared = Reflect.getMetadata(AUDIT_ACTION_KEY, handler) as AuditActionMetadata | undefined;
                if (verb === undefined || !declared) continue;
                handlers.set(`${RequestMethod[verb]} ${join(base, Reflect.getMetadata(PATH_METADATA, handler))}`, declared);
            }
        }
        catalogued = (Object.entries(ADMIN_AUDIT_CATALOG) as Array<[AuditActionName, { endpoints: readonly string[] }]>)
            .flatMap(([action, { endpoints }]) => endpoints.map((endpoint) => {
                const [method, route] = endpoint.split(' ') as [string, string];
                const params: Record<string, string> = {};
                const path = route.replace(/:(\w+)/g, (_, name: string) => {
                    const value = PARAM_VALUES[name];
                    if (!value) throw new Error(`No sweep value for :${name} in ${endpoint}`);
                    params[name] = value;
                    return value;
                });
                const declared = handlers.get(endpoint);
                if (!declared) throw new Error(`${endpoint} has no @AuditAction`);
                return { action, endpoint, verb: method.toLowerCase() as Verb, path, params, declared };
            }));

        // An admin that must change its password: authenticated, but every catalogued action is denied to it.
        const username = `${h.prefix}-mustchange`;
        const [{ user_id }] = await h.db.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, 'E2E must change', $2, $3, true) RETURNING user_id`,
            [h.roles.admin, username, await hashPassword(h.password)],
        );
        mustChange = { id: user_id, token: await h.login(username, h.password) };
    }, 60_000);

    afterEach(() => {
        express().set('trust proxy', false);
        vi.restoreAllMocks();
    });

    afterAll(async () => {
        await h.db?.query(`DROP TRIGGER IF EXISTS trg_e2e_audit_write_fail ON admin_audit_events`);
        await h.db?.query(`DROP FUNCTION IF EXISTS fn_e2e_audit_write_fail()`);
        await h.close();
    });

    it('sweeps the whole catalog (every action, every endpoint)', () => {
        const actions = new Set(catalogued.map((item) => item.action));
        expect(actions.size).toBe(Object.keys(ADMIN_AUDIT_CATALOG).length);
        expect(catalogued.length).toBe(Object.values(ADMIN_AUDIT_CATALOG).reduce((sum, { endpoints }) => sum + endpoints.length, 0));
    });

    describe('without a token: no actor', () => {
        it('every catalogued endpoint records one denied row that matches the request and keeps no secrets', async () => {
            for (const item of catalogued) {
                const correlationId = h.correlation();
                expectMatchesRequest(item, await send(item, null, correlationId), correlationId, null, 401);
            }
        }, 120_000);
    });

    describe('with an actor that must change its password first', () => {
        it('every catalogued endpoint records the denial with the actor, its role and the entity', async () => {
            // change-password is the one action this account is allowed to run.
            for (const item of catalogued.filter(({ endpoint }) => endpoint !== 'PATCH /auth/change-password')) {
                const correlationId = h.correlation();
                expectMatchesRequest(item, await send(item, mustChange.token, correlationId), correlationId, { id: mustChange.id, role: 'admin' }, 403);
            }
        }, 120_000);
    });

    describe('client IP and proxies', () => {
        const userDeletion = () => catalogued.find(({ endpoint }) => endpoint === 'DELETE /users/:id')!;
        const ipOf = async (forwardedFor: string) => {
            const correlationId = h.correlation();
            const response = await request(h.app.getHttpServer()).delete(`/${h.api}${userDeletion().path}`)
                .set('X-Request-Id', correlationId).set('X-Forwarded-For', forwardedFor);
            expect(response.status).toBe(401);
            const rows = await rowsOf(correlationId);
            expect(rows).toHaveLength(1);
            return rows[0]!.ip_address;
        };

        it('ignores X-Forwarded-For when no proxy is trusted', async () => {
            expect(LOOPBACK).toContain(await ipOf(FORGED_IP));
        });

        it('ignores it when the hop that sends it is not one of the trusted proxies', async () => {
            express().set('trust proxy', parseTrustProxy('10.9.9.9'));
            expect(LOOPBACK).toContain(await ipOf(FORGED_IP));
        });

        it('takes the client address that a trusted proxy reports', async () => {
            express().set('trust proxy', parseTrustProxy('loopback'));
            expect(await ipOf('198.51.100.20')).toBe('198.51.100.20');
        });

        it('with one trusted hop, a client cannot push a forged address in front of the real one', async () => {
            express().set('trust proxy', parseTrustProxy('1'));
            // The client sent "203.0.113.66"; the proxy appended the address it really saw.
            expect(await ipOf(`${FORGED_IP}, 198.51.100.21`)).toBe('198.51.100.21');
        });
    });

    describe('when the audit row cannot be written', () => {
        beforeAll(async () => {
            await h.db.query(`CREATE OR REPLACE FUNCTION fn_e2e_audit_write_fail() RETURNS trigger AS $$
                BEGIN IF NEW.correlation_id LIKE '%-wfail-%' THEN RAISE EXCEPTION 'e2e: audit storage unavailable'; END IF; RETURN NEW; END;
                $$ LANGUAGE plpgsql`);
            await h.db.query(`DROP TRIGGER IF EXISTS trg_e2e_audit_write_fail ON admin_audit_events`);
            await h.db.query(`CREATE TRIGGER trg_e2e_audit_write_fail BEFORE INSERT ON admin_audit_events FOR EACH ROW EXECUTE FUNCTION fn_e2e_audit_write_fail()`);
        });

        const failedWrites = (spy: ReturnType<typeof vi.spyOn>) =>
            spy.mock.calls.map(([entry]) => entry as Record<string, any>).filter((entry) => entry?.event === 'admin_audit_write_failed');

        it('a successful action keeps its result, and the event goes to the error log with no secrets', async () => {
            const spy = vi.spyOn(Logger.prototype, 'error');
            const correlationId = `${h.prefix}-wfail-1`;
            const username = `${h.prefix}-created-wfail`;
            const response = await request(h.app.getHttpServer()).post(`/${h.api}/users`)
                .set('X-Request-Id', correlationId).set('Authorization', `Bearer ${h.users.admin.token}`)
                .send({ fullName: 'E2E write fail', username, password: SECRETS.newPassword, roleId: h.roles.driver });

            expect(response.status).toBe(201);
            expect(await h.db.query('SELECT 1 FROM users WHERE user_id = $1', [response.body.id])).toHaveLength(1);
            expect(await rowsOf(correlationId)).toHaveLength(0);

            const logged = failedWrites(spy);
            expect(logged).toHaveLength(1);
            expect(logged[0]).toMatchObject({
                audit: {
                    action: 'user.created', actorId: h.users.admin.id, actorRole: 'admin', entityId: String(response.body.id),
                    result: 'success', statusCode: 201, correlationId, metadata: { roleId: h.roles.driver },
                },
            });
            expect(JSON.stringify(logged[0])).not.toContain(SECRETS.newPassword);
        });

        it('a denied request still gets its 401, and the lost event is logged too', async () => {
            const spy = vi.spyOn(Logger.prototype, 'error');
            const correlationId = `${h.prefix}-wfail-2`;
            const response = await request(h.app.getHttpServer()).put(`/${h.api}/users/${PARAM_VALUES.id}`)
                .set('X-Request-Id', correlationId).send(SECRETS);

            expect(response.status).toBe(401);
            expect(response.body.error).toBe('INVALID_TOKEN');
            const logged = failedWrites(spy);
            expect(logged).toHaveLength(1);
            expect(logged[0]).toMatchObject({ audit: { action: 'user.updated', actorId: null, result: 'denied', statusCode: 401, correlationId } });
            const text = JSON.stringify(logged[0]);
            for (const value of Object.values(SECRETS)) expect(text).not.toContain(value);
        });
    });
});
