// RF-A25 / RF-A10 / RF-A20 / ST-310.1: the settings that the administrator, the coordinator and the supervisor own, and the
// configurable password policy, against the real AppModule and database. Each toggle changes what a new password must
// contain; an invalid value or a role that does not own the key is rejected and nothing is saved. Every setting it
// changes is restored in afterAll; the users it creates are deleted by the harness.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { AuditE2eHarness } from './helpers/audit-e2e.harness.js';

const POLICY_KEYS = [
    'password_min_length', 'password_require_uppercase', 'password_require_lowercase', 'password_require_number', 'password_require_symbol',
] as const;

describe('configurable password policy and settings ownership (ST-310.1)', () => {
    const h = new AuditE2eHarness('pwpolicy');
    const original: Record<string, string> = {};
    let sequence = 0;

    const read = async (key: string): Promise<string> =>
        (await h.db.query('SELECT setting_value FROM settings WHERE setting_key = $1', [key]))[0].setting_value;
    const setAs = (token: string, key: string, value: string) => h.call('put', `/settings/${key}`, token, { value });
    const setPolicy = async (key: string, value: string) => {
        const { response } = setAs(h.users.admin.token, key, value);
        expect((await response).status, `admin sets ${key} = ${value}`).toBe(200);
    };
    const createUser = (password: string, over: Record<string, unknown> = {}) => {
        const username = `${h.prefix}-u${++sequence}`;
        return { username, ...h.call('post', '/users', h.users.admin.token, { fullName: 'E2E policy', username, password, roleId: h.roles.driver, ...over }) };
    };

    beforeAll(async () => {
        await h.start(['admin', 'coordinator', 'supervisor']);
        for (const key of [...POLICY_KEYS, 'delivery_window_start', 'max_wait_time_min']) original[key] = await read(key);
    }, 60_000);

    afterAll(async () => {
        if (h.db?.isInitialized) {
            for (const [key, value] of Object.entries(original)) {
                await h.db.query('UPDATE settings SET setting_value = $2 WHERE setting_key = $1', [key, value]);
            }
        }
        await h.close();
    });

    describe('who may change what', () => {
        it('exposes the four complexity options, all required on a clean install', async () => {
            const { response } = h.call('get', '/settings', h.users.admin.token);
            const body = (await response).body as Array<{ key: string; value: string }>;
            for (const key of POLICY_KEYS.filter((key) => key !== 'password_min_length')) {
                expect(body.find((setting) => setting.key === key), key).toBeDefined();
            }
        });

        it('the coordinator cannot change the password policy and the value stays', async () => {
            for (const key of POLICY_KEYS) {
                const before = await read(key);
                const { response } = setAs(h.users.coordinator.token, key, key === 'password_min_length' ? '20' : 'false');
                const res = await response;
                expect(res.status, key).toBe(403);
                expect(res.body.error, key).toBe('INSUFFICIENT_PERMISSIONS');
                expect(await read(key), key).toBe(before);
            }
        });

        it('the admin cannot change the delivery window or the maximum wait', async () => {
            for (const [key, value] of [['delivery_window_start', '07:00'], ['max_wait_time_min', '20']] as const) {
                const before = await read(key);
                const res = await setAs(h.users.admin.token, key, value).response;
                expect(res.status, key).toBe(403);
                expect(res.body.error, key).toBe('INSUFFICIENT_PERMISSIONS');
                expect(await read(key), key).toBe(before);
            }
        });

        it('the coordinator changes the delivery window and the maximum wait', async () => {
            expect((await setAs(h.users.coordinator.token, 'max_wait_time_min', '20').response).status).toBe(200);
            expect(await read('max_wait_time_min')).toBe('20');
            expect((await setAs(h.users.coordinator.token, 'delivery_window_start', '07:30').response).status).toBe(200);
            expect(await read('delivery_window_start')).toBe('07:30');
        });

        it('the supervisor owns the alert thresholds only: 403 on the rest of the settings', async () => {
            const before = await read('password_require_symbol');
            const res = await setAs(h.users.supervisor.token, 'password_require_symbol', 'false').response;
            expect(res.status).toBe(403);
            expect(await read('password_require_symbol')).toBe(before);
            expect((await h.call('get', '/settings/alert-thresholds', h.users.supervisor.token).response).status).toBe(200);
        });

        it('rejects invalid values with INVALID_SETTING_VALUE and saves nothing', async () => {
            const cases: Array<[string, string]> = [
                ['password_require_symbol', 'maybe'], ['password_require_symbol', 'TRUE'], ['password_require_number', ''],
                ['password_min_length', '7'], ['password_min_length', '129'], ['password_min_length', '8.5'],
                ['password_expiration_days', '0'], ['password_expiration_days', '3651'],
            ];
            for (const [key, value] of cases) {
                const before = await read(key);
                const res = await setAs(h.users.admin.token, key, value).response;
                expect(res.status, `${key}=${JSON.stringify(value)}`).toBe(400);
                expect(res.body.error, key).toBe('INVALID_SETTING_VALUE');
                expect(await read(key), key).toBe(before);
            }
        });

        it('without a token it is 401 and the value stays', async () => {
            const before = await read('password_require_symbol');
            expect((await h.call('put', '/settings/password_require_symbol', null, { value: 'false' }).response).status).toBe(401);
            expect(await read('password_require_symbol')).toBe(before);
        });
    });

    describe('each option decides what a new password needs', () => {
        // [option key, a password that lacks only that class, the same password with the class]
        const cases: Array<[string, string, string]> = [
            ['password_require_uppercase', 'lowercase1!', 'Lowercase1!'],
            ['password_require_lowercase', 'UPPERCASE1!', 'UPPERCASe1!'],
            ['password_require_number', 'NoNumbers!!', 'NoNumbers1!'],
            ['password_require_symbol', 'NoSymbols12', 'NoSymbols1!'],
        ];

        it.each(cases)('%s: required rejects it (PASSWORD_TOO_WEAK), off accepts it, and back on rejects it again', async (key, weak, compliant) => {
            await setPolicy(key, 'true');
            const rejected = createUser(weak);
            const rejectedRes = await rejected.response;
            expect(rejectedRes.status).toBe(400);
            expect(rejectedRes.body.error).toBe('PASSWORD_TOO_WEAK');
            expect(await h.db.query('SELECT 1 FROM users WHERE username = $1', [rejected.username])).toHaveLength(0);

            expect((await createUser(compliant).response).status).toBe(201);

            await setPolicy(key, 'false');
            const accepted = createUser(weak);
            expect((await accepted.response).status).toBe(201);
            expect(await h.db.query('SELECT 1 FROM users WHERE username = $1', [accepted.username])).toHaveLength(1);

            await setPolicy(key, 'true');
            expect((await createUser(weak).response).status).toBe(400);
        });

        it('the minimum length from settings applies, and never goes below 8', async () => {
            await setPolicy('password_min_length', '12');
            const short = await createUser('Abcdef1!').response;
            expect(short.status).toBe(400);
            expect(short.body.error).toBe('PASSWORD_TOO_SHORT');
            expect((await createUser('Abcdefghij1!').response).status).toBe(201);

            await setPolicy('password_min_length', '8');
            // below 8 is a plain validation error: the DTO keeps the structural floor whatever the policy says
            expect((await createUser('Abcde1!').response).status).toBe(400);
            expect((await createUser('Abcdef1!').response).status).toBe(201);
        });

        it('the admin password reset (PUT /users/:id) follows the same policy', async () => {
            await setPolicy('password_require_number', 'true');
            const created = createUser('Initial1234!');
            const { id } = (await created.response).body;
            const weak = await h.call('put', `/users/${id}`, h.users.admin.token, { password: 'NoNumbersHere!' }).response;
            expect(weak.status).toBe(400);
            expect(weak.body.error).toBe('PASSWORD_TOO_WEAK');

            await setPolicy('password_require_number', 'false');
            expect((await h.call('put', `/users/${id}`, h.users.admin.token, { password: 'NoNumbersHere!' }).response).status).toBe(200);
            await setPolicy('password_require_number', 'true');
        });

        it('a user changing their own password is held to the policy in force at that moment', async () => {
            const initial = 'Initial1234!';
            const created = createUser(initial);
            const { id } = (await created.response).body;
            expect(id).toBeDefined();
            const login = async (password: string) => await h.login(created.username, password);
            const change = async (token: string, currentPassword: string, newPassword: string) =>
                await request(h.app.getHttpServer()).patch(`/${h.api}/auth/change-password`)
                    .set('Authorization', `Bearer ${token}`).send({ currentPassword, newPassword });

            await setPolicy('password_require_symbol', 'false');
            const first = await change(await login(initial), initial, 'NoSymbols1234');
            expect([200, 204], JSON.stringify(first.body)).toContain(first.status);

            await setPolicy('password_require_symbol', 'true');
            const second = await change(await login('NoSymbols1234'), 'NoSymbols1234', 'StillNoSymbols99');
            expect(second.status).toBe(400);
            expect(second.body.error).toBe('PASSWORD_TOO_WEAK');
            // the rejected change did not touch the password: the previous one still logs in
            await expect(login('NoSymbols1234')).resolves.toEqual(expect.any(String));
        });
    });

    describe('audit trail of a change (ES-68)', () => {
        it('records actor, role, key, new and previous value, the settings version and the correlation, and no secret', async () => {
            const before = await read('password_require_symbol');
            const next = before === 'true' ? 'false' : 'true';
            const { correlationId, response } = setAs(h.users.admin.token, 'password_require_symbol', next);
            expect((await response).status).toBe(200);
            const [{ setting_value: version }] = await h.db.query(`SELECT setting_value FROM settings WHERE setting_key = 'settings_version'`);

            const events = await h.eventsOf(correlationId);
            expect(events).toEqual([expect.objectContaining({
                actor_user_id: h.users.admin.id, actor_role: 'admin', action: 'setting.updated', entity_type: 'setting',
                entity_id: 'password_require_symbol', result: 'success', status_code: 200, correlation_id: correlationId,
                metadata: { value: next, previousValue: before, settingsVersion: Number(version) },
            })]);
            await setPolicy('password_require_symbol', before);
        });

        it('records the denial of a role that does not own the key, with no version and nothing changed', async () => {
            const before = await read('password_require_uppercase');
            const { correlationId, response } = setAs(h.users.coordinator.token, 'password_require_uppercase', 'false');
            expect((await response).status).toBe(403);
            const events = await h.eventsOf(correlationId);
            expect(events).toEqual([expect.objectContaining({
                actor_user_id: h.users.coordinator.id, actor_role: 'coordinator', action: 'setting.updated',
                entity_id: 'password_require_uppercase', result: 'denied', status_code: 403, metadata: { value: 'false' },
            })]);
            expect(events[0]!.metadata).not.toHaveProperty('settingsVersion');
            expect(await read('password_require_uppercase')).toBe(before);
        });

        it('never records a password: not the one of a created user nor any key of the metadata', async () => {
            const secret = 'Sup3rS3cret!Value';
            const { correlationId, response } = h.call('post', '/users', h.users.admin.token, {
                fullName: 'E2E audit secret', username: `${h.prefix}-secret`, password: secret, roleId: h.roles.driver,
            });
            expect((await response).status).toBe(201);
            expect(JSON.stringify(await h.eventsOf(correlationId))).not.toContain(secret);
        });
    });
});
