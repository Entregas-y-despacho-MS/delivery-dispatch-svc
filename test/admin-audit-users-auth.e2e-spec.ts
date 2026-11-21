// RF-A35 / ST-68.2: audit trail of the sensitive handlers of the "users and authentication" family
// (user.created, user.updated, user.deleted, auth.password_changed, auth.two_factor_changed): one allowed and one
// denied operation of each, against the real AppModule and database. Everything it creates is deleted in afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditE2eHarness } from './helpers/audit-e2e.harness.js';

describe('audit of users and authentication (ST-68.2)', () => {
    const h = new AuditE2eHarness('audit-users');
    const strong = 'Passw0rd!Strong1';

    const newUser = (suffix: string, roleId: number) => ({
        fullName: `E2E ${suffix}`, username: `${h.prefix}-${suffix}`, password: strong, roleId,
    });
    const insertUser = async (suffix: string, role: 'driver' | 'supervisor'): Promise<number> => {
        const [{ user_id }] = await h.db.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, 'x', false) RETURNING user_id`,
            [h.roles[role], `E2E ${suffix}`, `${h.prefix}-${suffix}`],
        );
        return user_id as number;
    };

    beforeAll(async () => { await h.start(['admin', 'coordinator', 'supervisor']); }, 30_000);
    afterAll(async () => { await h.close(); });

    describe.each([['POST /users', '/users'], ['POST /auth/register', '/auth/register']])('user.created — %s', (_label, path) => {
        it('records the creation by an admin with the id of the new user, and no password', async () => {
            const suffix = path === '/users' ? 'created-a' : 'created-b';
            const { correlationId, response } = h.call('post', path, h.users.admin.token, newUser(suffix, h.roles.driver!));
            const res = await response;
            expect(res.status).toBe(201);
            const rows = await h.eventsOf(correlationId);
            expect(rows).toEqual([expect.objectContaining({
                actor_user_id: h.users.admin.id, actor_role: 'admin', action: 'user.created', entity_type: 'user',
                entity_id: String(res.body.id), result: 'success', status_code: 201, metadata: { roleId: h.roles.driver },
            })]);
            expect(JSON.stringify(rows)).not.toContain(strong);
        });

        it('records the denial of a coordinator and does not create the account', async () => {
            const suffix = path === '/users' ? 'denied-a' : 'denied-b';
            const { correlationId, response } = h.call('post', path, h.users.coordinator.token, newUser(suffix, h.roles.driver!));
            expect((await response).status).toBe(403);
            expect(await h.eventsOf(correlationId)).toEqual([expect.objectContaining({
                actor_user_id: h.users.coordinator.id, actor_role: 'coordinator', action: 'user.created',
                entity_id: null, result: 'denied', status_code: 403,
            })]);
            expect(await h.db.query('SELECT 1 FROM users WHERE username = $1', [`${h.prefix}-${suffix}`])).toHaveLength(0);
        });
    });

    describe('user.updated — PUT /users/:id', () => {
        it('records the edit by an admin on the edited user, with the activation flag and without the password', async () => {
            const target = await insertUser('edit', 'driver');
            const { correlationId, response } = h.call('put', `/users/${target}`, h.users.admin.token, { active: false, password: strong });
            expect((await response).status).toBe(200);
            const rows = await h.eventsOf(correlationId);
            expect(rows).toEqual([expect.objectContaining({
                actor_user_id: h.users.admin.id, action: 'user.updated', entity_id: String(target),
                result: 'success', status_code: 200, metadata: { active: false },
            })]);
            expect(JSON.stringify(rows)).not.toContain(strong);
        });

        it('records the denial of a coordinator and leaves the user unchanged', async () => {
            const target = await insertUser('edit-denied', 'driver');
            const { correlationId, response } = h.call('put', `/users/${target}`, h.users.coordinator.token, { active: false });
            expect((await response).status).toBe(403);
            expect(await h.eventsOf(correlationId)).toEqual([expect.objectContaining({
                actor_user_id: h.users.coordinator.id, action: 'user.updated', entity_id: String(target), result: 'denied', status_code: 403,
            })]);
            expect((await h.db.query('SELECT active FROM users WHERE user_id = $1', [target]))[0].active).toBe(true);
        });
    });

    describe('user.deleted — DELETE /users/:id', () => {
        it('records the deletion by an admin', async () => {
            const target = await insertUser('delete', 'driver');
            const { correlationId, response } = h.call('delete', `/users/${target}`, h.users.admin.token);
            expect((await response).status).toBe(204);
            expect(await h.eventsOf(correlationId)).toEqual([expect.objectContaining({
                actor_user_id: h.users.admin.id, action: 'user.deleted', entity_id: String(target), result: 'success', status_code: 204,
            })]);
        });

        it('records the denial of a coordinator and keeps the user, and a missing user as failed', async () => {
            const target = await insertUser('delete-denied', 'driver');
            const denied = h.call('delete', `/users/${target}`, h.users.coordinator.token);
            expect((await denied.response).status).toBe(403);
            expect(await h.eventsOf(denied.correlationId)).toEqual([expect.objectContaining({
                actor_user_id: h.users.coordinator.id, action: 'user.deleted', entity_id: String(target), result: 'denied', status_code: 403,
            })]);
            expect((await h.db.query('SELECT deleted_at FROM users WHERE user_id = $1', [target]))[0].deleted_at).toBeNull();

            const missing = h.call('delete', '/users/999999999', h.users.admin.token);
            expect((await missing.response).status).toBe(404);
            expect(await h.eventsOf(missing.correlationId)).toEqual([expect.objectContaining({ result: 'failed', status_code: 404, entity_id: '999999999' })]);
        });
    });

    describe('auth.password_changed — PATCH /auth/change-password', () => {
        it('records a wrong current password as denied, with the actor as the entity and no password stored', async () => {
            const { correlationId, response } = h.call('patch', '/auth/change-password', h.users.supervisor.token, {
                currentPassword: 'WrongPassw0rd!1', newPassword: 'N3wPassw0rd!Zz',
            });
            expect((await response).status).toBe(401);
            const rows = await h.eventsOf(correlationId);
            expect(rows).toEqual([expect.objectContaining({
                actor_user_id: h.users.supervisor.id, actor_role: 'supervisor', action: 'auth.password_changed',
                entity_id: String(h.users.supervisor.id), result: 'denied', status_code: 401, metadata: {},
            })]);
            expect(JSON.stringify(rows)).not.toMatch(/WrongPassw0rd|N3wPassw0rd/);
        });

        it('records the change of the own password as success', async () => {
            const { correlationId, response } = h.call('patch', '/auth/change-password', h.users.supervisor.token, {
                currentPassword: h.password, newPassword: 'N3wPassw0rd!Zz',
            });
            expect((await response).status).toBe(204);
            const rows = await h.eventsOf(correlationId);
            expect(rows).toEqual([expect.objectContaining({
                actor_user_id: h.users.supervisor.id, action: 'auth.password_changed',
                entity_id: String(h.users.supervisor.id), result: 'success', status_code: 204,
            })]);
            expect(JSON.stringify(rows)).not.toMatch(/N3wPassw0rd/);
        });

        it('records an attempt without a token with no actor', async () => {
            const { correlationId, response } = h.call('patch', '/auth/change-password', null, { currentPassword: 'x', newPassword: 'y' });
            expect((await response).status).toBe(401);
            expect(await h.eventsOf(correlationId)).toEqual([expect.objectContaining({
                actor_user_id: null, action: 'auth.password_changed', entity_id: null, result: 'denied', status_code: 401,
            })]);
        });
    });

    describe('auth.two_factor_changed — POST /auth/2fa/*', () => {
        it('records enable, confirm and disable of the own 2FA with the step, and never the secret or the password', async () => {
            const token = h.users.coordinator.token;
            const steps: Array<{ step: string; path: string; body: object; status: number; result: string }> = [
                { step: 'enable', path: '/auth/2fa/enable', body: { password: 'WrongPassw0rd!1' }, status: 401, result: 'denied' },
                { step: 'enable', path: '/auth/2fa/enable', body: { password: h.password }, status: 200, result: 'success' },
                { step: 'confirm', path: '/auth/2fa/confirm', body: { code: '000000' }, status: 401, result: 'denied' },
                { step: 'disable', path: '/auth/2fa/disable', body: { password: h.password }, status: 204, result: 'success' },
            ];
            for (const { step, path, body, status, result } of steps) {
                const { correlationId, response } = h.call('post', path, token, body);
                const res = await response;
                expect(res.status).toBe(status);
                const rows = await h.eventsOf(correlationId);
                expect(rows).toEqual([expect.objectContaining({
                    actor_user_id: h.users.coordinator.id, actor_role: 'coordinator', action: 'auth.two_factor_changed',
                    entity_id: String(h.users.coordinator.id), result, status_code: status, metadata: { step },
                })]);
                const secret = (res.body as { secret?: string }).secret;
                if (secret) expect(JSON.stringify(rows)).not.toContain(secret);
                expect(JSON.stringify(rows)).not.toMatch(/WrongPassw0rd|000000/);
            }
        });

        it('records an attempt without a token with no actor', async () => {
            const { correlationId, response } = h.call('post', '/auth/2fa/disable', null, { password: 'x' });
            expect((await response).status).toBe(401);
            expect(await h.eventsOf(correlationId)).toEqual([expect.objectContaining({
                actor_user_id: null, action: 'auth.two_factor_changed', entity_id: null, result: 'denied', status_code: 401, metadata: { step: 'disable' },
            })]);
        });
    });
});
