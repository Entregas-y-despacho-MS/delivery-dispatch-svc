// ST-310.4 (ES-310, RF-A10/A20/A25) — password policy, role matrix, root seed and audit, against the real AppModule,
// the real seed script and a real database. API only: the settings screen is not part of this suite.
//
// What `password-policy-settings.e2e-spec.ts` and `root-bootstrap.e2e-spec.ts` already prove is not repeated here
// (each toggle on its own, the floor of 8, `seedRootUser` called as a function). This one covers the 16 combinations
// of the four toggles, the exact length boundaries up to 128, every path that sets a password (including register and
// reset by token), expiration, "a new policy only affects new passwords", the full role x action matrix with what a
// denial leaves behind, concurrent changes, a restart, and the seed run as a process.
//
// It needs a database with the DEFAULT password policy (clean install or migrated): the first test checks it. Every
// setting is restored in afterAll and every user, audit event and trigger it creates is deleted.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { AuditE2eHarness, type AuditRow } from './helpers/audit-e2e.harness.js';
import { MailerPort } from '../src/plugins/mailer/mailer.port.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { DEFAULT_PASSWORD_POLICY } from '../src/shared/validators/password.validator.js';

// Hundreds of requests from one IP: the rate limits are not what is under test. Set before AppModule is imported
// (the sensitive limit is read when the controllers are defined).
const previousThrottle = vi.hoisted(() => {
    const previous = { THROTTLE_LIMIT: process.env.THROTTLE_LIMIT, THROTTLE_SENSITIVE_LIMIT: process.env.THROTTLE_SENSITIVE_LIMIT };
    process.env.THROTTLE_LIMIT = '100000';
    process.env.THROTTLE_SENSITIVE_LIMIT = '100000';
    return previous;
});

const TOGGLES = ['password_require_uppercase', 'password_require_lowercase', 'password_require_number', 'password_require_symbol'] as const;
const POLICY_KEYS = ['password_min_length', 'password_expiration_days', ...TOGGLES] as const;
type PolicyKey = typeof POLICY_KEYS[number];
type PolicyValues = Partial<Record<PolicyKey, string>>;

const CLEAN_DEFAULTS: Record<PolicyKey, string> = {
    password_min_length: '8', password_expiration_days: '90', password_require_uppercase: 'true',
    password_require_lowercase: 'true', password_require_number: 'true', password_require_symbol: 'true',
};

type Actor = 'admin' | 'coordinator' | 'supervisor' | 'driver' | 'root' | 'anonymous';
const ACTORS: readonly Actor[] = ['admin', 'coordinator', 'supervisor', 'driver', 'root', 'anonymous'];

/** Reference table, written by hand from the role rules: HTTP status per actor, in the order of ACTORS. */
const EXPECTED = {
    //                       admin coord superv driver root  anonymous
    readSettings:           [200,  200,  403,   403,   200,  401],
    readThresholds:         [403,  200,  200,   403,   200,  401],
    writePasswordPolicy:    [200,  403,  403,   403,   200,  401],
    writeOperationalSetting:[403,  200,  403,   403,   200,  401],
    writeThresholds:        [403,  403,  200,   403,   200,  401],
} as const;

describe('password policy, role matrix, root seed and audit (ST-310.4)', () => {
    const h = new AuditE2eHarness('pwmatrix');
    const mails: Array<{ to: string; html: string }> = [];
    const original: Record<string, string> = {};
    const slowTrigger = `e2e_pwmatrix_slow_${Date.now().toString(36)}`;
    let rootActor: { id: number; token: string };
    let sequence = 0;

    // ── helpers ────────────────────────────────────────────────────────────
    const snapshot = async (): Promise<Record<string, string>> => Object.fromEntries(
        (await h.db.query('SELECT setting_key, setting_value FROM settings ORDER BY setting_key'))
            .map((row: { setting_key: string; setting_value: string }) => [row.setting_key, row.setting_value]),
    );
    const tokenOf = (actor: Actor): string | null =>
        actor === 'anonymous' ? null : actor === 'root' ? rootActor.token : h.users[actor].token;
    const actorId = (actor: Exclude<Actor, 'anonymous'>): number => (actor === 'root' ? rootActor.id : h.users[actor].id);

    const putSetting = (token: string | null, key: string, value: unknown) =>
        h.call('put', `/settings/${key}`, token, { value } as object);
    /** The admin sets the policy through the API; only the keys that differ are sent. */
    const setPolicy = async (values: PolicyValues): Promise<void> => {
        const current = await snapshot();
        for (const [key, value] of Object.entries(values)) {
            if (current[key] === value) continue;
            const res = await putSetting(h.users.admin.token, key, value).response;
            expect(res.status, `admin sets ${key} = ${value}: ${JSON.stringify(res.body)}`).toBe(200);
        }
    };

    const newUsername = () => `${h.prefix}-n${++sequence}`;
    const newUserBody = (username: string, password: string, role = 'driver') =>
        ({ fullName: 'E2E policy matrix', username, password, roleId: h.roles[role] });
    const create = (password: string, role = 'driver', path = '/users') => {
        const username = newUsername();
        return { username, ...h.call('post', path, h.users.admin.token, newUserBody(username, password, role)) };
    };
    /** A user inserted directly: for setups where the password must not depend on the policy in force. */
    const insertUser = async (role: string, password: string, email: string | null = null) => {
        const username = newUsername();
        const [{ user_id }] = await h.db.query(
            `INSERT INTO users (role_id, full_name, username, email, password_hash, requires_pwd_change) VALUES ($1, 'E2E policy matrix', $2, $3, $4, false) RETURNING user_id`,
            [h.roles[role], username, email, await hashPassword(password)],
        );
        return { id: user_id as number, username };
    };
    const userByName = async (username: string) => (await h.db.query('SELECT * FROM users WHERE username = $1', [username]))[0];
    const credentials = async (id: number) => (await h.db.query(
        `SELECT full_name, password_hash, password_changed_at, requires_pwd_change, password_reset_token,
                (SELECT count(*)::int FROM password_history ph WHERE ph.user_id = u.user_id) AS history
           FROM users u WHERE user_id = $1`, [id],
    ))[0];
    const login = (username: string, password: string) =>
        request(h.app.getHttpServer()).post(`/${h.api}/auth/login`).send({ username, password });
    const changePassword = (token: string, currentPassword: string, newPassword: string) =>
        h.call('patch', '/auth/change-password', token, { currentPassword, newPassword });
    /** JWT `iat` has second resolution and a password change closes older tokens. */
    const nextSecond = () => new Promise((resolve) => setTimeout(resolve, 1_100));

    beforeAll(async () => {
        await h.start(['admin', 'coordinator', 'supervisor', 'driver'], (builder) =>
            builder.overrideProvider(MailerPort).useValue({ send: (mail: { to: string; html: string }) => { mails.push(mail); } }));
        Object.assign(original, await snapshot());
        const root = await insertUser('root', h.password);
        rootActor = { id: root.id, token: await h.login(root.username, h.password) };
    }, 60_000);

    afterAll(async () => {
        for (const [key, value] of Object.entries(previousThrottle)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        if (h.db?.isInitialized) {
            await h.db.query(`DROP TRIGGER IF EXISTS ${slowTrigger} ON settings`);
            await h.db.query(`DROP FUNCTION IF EXISTS ${slowTrigger}()`);
            for (const [key, value] of Object.entries(original)) {
                await h.db.query('UPDATE settings SET setting_value = $2 WHERE setting_key = $1 AND setting_value IS DISTINCT FROM $2', [key, value]);
            }
            // The seeded roots carry the same prefix, so the harness deletes them too.
        }
        await h.close();
    });

    // ── clean install ──────────────────────────────────────────────────────
    it('starts from the default policy: minimum 8, 90 days and the four classes, the same the code and the seed assume', () => {
        expect(Object.fromEntries(POLICY_KEYS.map((key) => [key, original[key]]))).toEqual(CLEAN_DEFAULTS);
        expect(DEFAULT_PASSWORD_POLICY).toEqual({
            minLength: Number(original.password_min_length),
            requireUppercase: true, requireLowercase: true, requireNumber: true, requireSymbol: true,
        });
    });

    // ── 16 combinations ────────────────────────────────────────────────────
    describe('the 16 combinations of the four complexity options', () => {
        // One character per class, and a filler that belongs to none of them (a letter without case).
        const SAMPLES = ['Q', 'k', '7', '!'];
        const NAMES = ['1 uppercase letter', '1 lowercase letter', '1 number', '1 special character'];
        const FILLER = '中';
        const bits = (mask: number) => [0, 1, 2, 3].filter((bit) => mask & (1 << bit));
        const passwordWith = (present: number) => bits(present).map((bit) => SAMPLES[bit]).join('').padEnd(8, FILLER);

        it('accepts a new password exactly when it has every required class, and names only the missing ones', async () => {
            await setPolicy({ password_min_length: '8' });
            let accepted = 0;
            let rejected = 0;
            for (let required = 0; required < 16; required++) {
                await setPolicy(Object.fromEntries(TOGGLES.map((key, bit) => [key, String(Boolean(required & (1 << bit)))])));
                for (let present = 0; present < 16; present++) {
                    const label = `required=${required.toString(2).padStart(4, '0')} present=${present.toString(2).padStart(4, '0')}`;
                    const attempt = create(passwordWith(present));
                    const res = await attempt.response;
                    const missing = bits(required & ~present);
                    if (missing.length === 0) {
                        accepted++;
                        expect(res.status, label).toBe(201);
                        expect(await userByName(attempt.username), label).toBeDefined();
                    } else {
                        rejected++;
                        expect(res.status, label).toBe(400);
                        expect(res.body, label).toMatchObject({
                            error: 'PASSWORD_TOO_WEAK',
                            message: `Password must include at least ${missing.map((bit) => NAMES[bit]).join(', ')}.`,
                        });
                        expect(await userByName(attempt.username), label).toBeUndefined();
                    }
                }
            }
            // With k required classes, 2^(4-k) of the 16 passwords comply: 16 + 4*8 + 6*4 + 4*2 + 1 = 81.
            expect({ accepted, rejected }).toEqual({ accepted: 81, rejected: 175 });
            await setPolicy(CLEAN_DEFAULTS);
        }, 120_000);
    });

    // ── length and invalid values ──────────────────────────────────────────
    describe('minimum length and accepted values', () => {
        const ofLength = (length: number) => 'Aa1!'.padEnd(length, 'x');

        it.each([8, 12, 64, 128])('with minimum %i, N-1 characters are rejected and N are accepted and log in', async (minimum) => {
            await setPolicy({ password_min_length: String(minimum) });
            expect((await snapshot()).password_min_length).toBe(String(minimum));

            const short = create(ofLength(minimum - 1));
            const shortRes = await short.response;
            expect(shortRes.status).toBe(400);
            // Below the floor of 8 the DTO answers first (a plain validation error); above it, the configured policy does.
            if (minimum === 8) expect(shortRes.body.message).toEqual(['Password must be at least 8 characters.']);
            else expect(shortRes.body).toMatchObject({ error: 'PASSWORD_TOO_SHORT', message: `Password must be at least ${minimum} characters.` });
            expect(await userByName(short.username)).toBeUndefined();

            const exact = create(ofLength(minimum));
            expect((await exact.response).status).toBe(201);
            expect((await login(exact.username, ofLength(minimum))).status).toBe(200);
            await setPolicy(CLEAN_DEFAULTS);
        });

        it.each([
            ['password_min_length', '7'], ['password_min_length', '129'], ['password_min_length', '-8'], ['password_min_length', '1e2'],
            ['password_min_length', ' 9'], ['password_min_length', 'doce'], ['password_min_length', ''], ['password_min_length', 12],
            ['password_expiration_days', '-1'], ['password_expiration_days', '1.5'], ['password_expiration_days', ''],
            ['password_expiration_days', 'never'], ['password_expiration_days', 30],
            ['password_require_uppercase', '1'], ['password_require_lowercase', 'False'], ['password_require_number', ' true'],
            ['password_require_symbol', false],
        ] as Array<[PolicyKey, unknown]>)('rejects %s = %j and saves neither the value nor a new version', async (key, value) => {
            const before = await snapshot();
            const { correlationId, response } = putSetting(h.users.admin.token, key, value);
            expect((await response).status).toBe(400);
            expect(await snapshot()).toEqual(before);
            const events = await h.eventsOf(correlationId);
            expect(events).toEqual([expect.objectContaining({ action: 'setting.updated', entity_id: key, result: 'failed', status_code: 400 })]);
            expect(events[0]!.metadata).not.toHaveProperty('settingsVersion');
            expect(events[0]!.metadata).not.toHaveProperty('previousValue');
        });

        it.each(['1', '3650'])('accepts the expiration boundary of %s days', async (days) => {
            await setPolicy({ password_expiration_days: days });
            expect((await snapshot()).password_expiration_days).toBe(days);
            await setPolicy(CLEAN_DEFAULTS);
        });
    });

    // ── every path that sets a password ────────────────────────────────────
    describe('every path that sets a password applies the configured policy', () => {
        // Longer than the default and without numbers or symbols: each sample tells the two policies apart.
        const CONFIGURED: PolicyValues = { password_min_length: '14', password_require_number: 'false', password_require_symbol: 'false' };
        const REJECTED = [
            { password: 'Short1!aaPwd', error: 'PASSWORD_TOO_SHORT' },        // complies with the default policy, 12 < 14
            { password: 'onlylowercaseletters', error: 'PASSWORD_TOO_WEAK' }, // long enough, no uppercase
        ];
        const ACCEPTED = 'OnlyLettersLongEnough'; // the default policy would reject it
        const INITIAL = 'Initial1234!Pass';

        const output: string[] = [];
        const spies: Array<{ mockRestore: () => void }> = [];
        beforeAll(async () => {
            await setPolicy(CONFIGURED);
            // The testing module silences every level but errors: put the real logger back so there is output to inspect.
            h.app.useLogger(new ConsoleLogger());
            for (const stream of [process.stdout, process.stderr]) {
                const write = stream.write.bind(stream);
                spies.push(vi.spyOn(stream, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: never[]) => {
                    output.push(String(chunk));
                    return write(chunk, ...rest);
                }) as typeof stream.write));
            }
        });
        afterAll(async () => {
            spies.forEach((spy) => spy.mockRestore());
            h.app.useLogger(new ConsoleLogger({ logLevels: ['error', 'fatal'] }));
            await setPolicy(CLEAN_DEFAULTS);
        });

        const expectNoSecret = async (correlationId: string, body: unknown, secrets: string[]) => {
            const stored = JSON.stringify([body, await h.eventsOf(correlationId)]);
            for (const secret of secrets) expect(stored).not.toContain(secret);
        };

        it.each(['/users', '/auth/register'])('POST %s', async (path) => {
            for (const { password, error } of REJECTED) {
                const attempt = create(password, 'driver', path);
                const res = await attempt.response;
                expect([res.status, res.body.error], password).toEqual([400, error]);
                expect(await userByName(attempt.username)).toBeUndefined();
                await expectNoSecret(attempt.correlationId, res.body, [password]);
            }
            const ok = create(ACCEPTED, 'driver', path);
            const res = await ok.response;
            expect(res.status).toBe(201);
            expect((await login(ok.username, ACCEPTED)).status).toBe(200);
            await expectNoSecret(ok.correlationId, res.body, [ACCEPTED, (await userByName(ok.username)).password_hash]);
        });

        it('PUT /users/:id: a rejected password also discards the other fields of the request', async () => {
            const user = await insertUser('driver', INITIAL);
            const before = await credentials(user.id);
            for (const { password, error } of REJECTED) {
                const attempt = h.call('put', `/users/${user.id}`, h.users.admin.token, { fullName: 'Must not be saved', password });
                const res = await attempt.response;
                expect([res.status, res.body.error], password).toEqual([400, error]);
                expect(await credentials(user.id)).toEqual(before);
                await expectNoSecret(attempt.correlationId, res.body, [password]);
            }
            const ok = h.call('put', `/users/${user.id}`, h.users.admin.token, { password: ACCEPTED });
            expect((await ok.response).status).toBe(200);
            expect((await login(user.username, ACCEPTED)).status).toBe(200);
            await expectNoSecret(ok.correlationId, (await ok.response).body, [ACCEPTED]);
        });

        it('PATCH /auth/change-password: a rejected change leaves password, date and history as they were', async () => {
            const user = await insertUser('driver', INITIAL);
            const token = await h.login(user.username, INITIAL);
            const before = await credentials(user.id);
            for (const { password, error } of REJECTED) {
                const attempt = changePassword(token, INITIAL, password);
                const res = await attempt.response;
                expect([res.status, res.body.error], password).toEqual([400, error]);
                expect(await credentials(user.id)).toEqual(before);
                await expectNoSecret(attempt.correlationId, res.body, [password, INITIAL]);
            }
            await nextSecond();
            const ok = changePassword(token, INITIAL, ACCEPTED);
            expect((await ok.response).status).toBe(204);
            expect((await credentials(user.id)).history).toBe(1);
            expect((await login(user.username, ACCEPTED)).status).toBe(200);
            expect((await login(user.username, INITIAL)).status).toBe(401);
            await expectNoSecret(ok.correlationId, {}, [ACCEPTED, INITIAL]);
        });

        it('POST /auth/reset-password: a rejected password does not spend the emailed token', async () => {
            const email = `${h.prefix}-reset@example.test`;
            const user = await insertUser('coordinator', INITIAL, email);
            mails.length = 0;
            expect((await h.call('post', '/auth/forgot-password', null, { email }).response).status).toBe(204);
            const token = mails.find((mail) => mail.to === email)!.html.match(/[0-9a-f]{64}/)![0];
            const before = await credentials(user.id);
            expect(before.password_reset_token).not.toBeNull();

            for (const { password, error } of REJECTED) {
                const res = await h.call('post', '/auth/reset-password', null, { token, newPassword: password }).response;
                expect([res.status, res.body.error], password).toEqual([400, error]);
                expect(await credentials(user.id)).toEqual(before);
                expect(JSON.stringify(res.body)).not.toContain(password);
            }
            expect((await h.call('post', '/auth/reset-password', null, { token, newPassword: ACCEPTED }).response).status).toBe(204);
            expect((await login(user.username, ACCEPTED)).status).toBe(200);
            const reused = await h.call('post', '/auth/reset-password', null, { token, newPassword: `${ACCEPTED}Again` }).response;
            expect([reused.status, reused.body.error]).toEqual([401, 'INVALID_RESET_TOKEN']);
        });

        it('none of the passwords sent in those requests reached the process output', () => {
            const canary = `${h.prefix}-canary`;
            new Logger('e2e').warn(canary);
            const written = output.join('');
            expect(written).toContain(canary); // the capture sees what the service logs
            for (const secret of [INITIAL, ACCEPTED, ...REJECTED.map(({ password }) => password)]) expect(written).not.toContain(secret);
        });
    });

    // ── a new policy only affects new passwords ────────────────────────────
    describe('a new policy only affects passwords set from then on', () => {
        afterAll(async () => { await setPolicy(CLEAN_DEFAULTS); });

        it('an existing password that no longer complies keeps working, and nobody is rewritten or forced to change', async () => {
            await setPolicy(Object.fromEntries(TOGGLES.map((key) => [key, 'false'])));
            // The owner picks a password that only the relaxed policy allows, through the real change.
            const weak = 'abcdefgh';
            const owner = create('Initial1234!', 'coordinator');
            const { id } = (await owner.response).body as { id: number };
            const firstSession = await h.login(owner.username, 'Initial1234!');
            await nextSecond();
            expect((await changePassword(firstSession, 'Initial1234!', weak).response).status).toBe(204);
            const sessionBefore = (await login(owner.username, weak)).body as { accessToken: string; refreshToken: string };
            const before = await credentials(id);

            await setPolicy({ ...CLEAN_DEFAULTS, password_min_length: '20' });

            expect(await credentials(id)).toEqual(before);
            const again = await login(owner.username, weak);
            expect(again.status).toBe(200);
            expect(again.body.mustChangePassword).toBe(false);
            expect((await h.call('get', '/settings', again.body.accessToken).response).status).toBe(200);
            const refreshed = await h.call('post', '/auth/refresh', null, { refreshToken: again.body.refreshToken }).response;
            expect([refreshed.status, refreshed.body.mustChangePassword]).toEqual([200, false]);
            expect((await h.call('get', '/settings', sessionBefore.accessToken).response).status).toBe(200);

            // An admin edit that does not touch the password is not held to the policy.
            expect((await h.call('put', `/users/${id}`, h.users.admin.token, { fullName: 'Renamed' }).response).status).toBe(200);
            expect((await credentials(id)).password_hash).toBe(before.password_hash);

            // The old password is not revalidated when it is presented as the current one; the new one is.
            const token = refreshed.body.accessToken as string;
            const stillShort = await changePassword(token, weak, 'Abcdef1!Abcdef1!').response;
            expect([stillShort.status, stillShort.body.error]).toEqual([400, 'PASSWORD_TOO_SHORT']);
            await nextSecond();
            expect((await changePassword(token, weak, 'Abcdefghij1!Abcdefghij').response).status).toBe(204);
        });
    });

    // ── expiration ─────────────────────────────────────────────────────────
    describe('password expiration set through the API', () => {
        afterAll(async () => { await setPolicy(CLEAN_DEFAULTS); });

        const PASSWORD = 'Expiring1234!';
        const age = (id: number, hours: number) =>
            h.db.query(`UPDATE users SET password_changed_at = now() - make_interval(hours => $2) WHERE user_id = $1`, [id, hours]);

        it.each([
            // [days configured, age of the password in hours, must change]
            ['1', 23, false], ['1', 25, true],
            ['30', 30 * 24 - 1, false], ['30', 30 * 24 + 1, true],
            ['90', 31 * 24, false],
            ['3650', 3650 * 24 - 1, false], ['3650', 3650 * 24 + 1, true],
        ] as Array<[string, number, boolean]>)('%s day(s) with a password %i hours old: must change = %s', async (days, hours, expired) => {
            await setPolicy({ password_expiration_days: days });
            const user = await insertUser('coordinator', PASSWORD);
            await age(user.id, hours);

            const session = await login(user.username, PASSWORD);

            expect([session.status, session.body.mustChangePassword]).toEqual([200, expired]);
            const read = await h.call('get', '/settings', session.body.accessToken).response;
            expect([read.status, read.body.error]).toEqual(expired ? [403, 'PASSWORD_CHANGE_REQUIRED'] : [200, undefined]);
        });

        it('shortening it blocks an open session at once, without persisting what it tries; changing the password releases it', async () => {
            await setPolicy({ password_expiration_days: '90' });
            const user = await insertUser('coordinator', PASSWORD);
            await age(user.id, 10 * 24);
            const session = (await login(user.username, PASSWORD)).body as { accessToken: string; refreshToken: string };
            expect((await h.call('get', '/settings', session.accessToken).response).status).toBe(200);

            await setPolicy({ password_expiration_days: '5' });

            const before = await snapshot();
            const blocked = putSetting(session.accessToken, 'max_wait_time_min', '44');
            const res = await blocked.response;
            expect([res.status, res.body.error]).toEqual([403, 'PASSWORD_CHANGE_REQUIRED']);
            expect(await snapshot()).toEqual(before);
            // The guard records the denial without waiting for it.
            await vi.waitFor(async () => expect(await h.eventsOf(blocked.correlationId)).toEqual([expect.objectContaining({
                actor_user_id: user.id, actor_role: 'coordinator', action: 'setting.updated', result: 'denied', status_code: 403,
            })]));
            const refreshed = await h.call('post', '/auth/refresh', null, { refreshToken: session.refreshToken }).response;
            expect([refreshed.status, refreshed.body.mustChangePassword]).toEqual([200, true]);

            // Lengthening it releases the same session: expiration is evaluated on every request.
            await setPolicy({ password_expiration_days: '90' });
            expect((await h.call('get', '/settings', session.accessToken).response).status).toBe(200);

            await setPolicy({ password_expiration_days: '5' });
            await nextSecond();
            expect((await changePassword(refreshed.body.accessToken, PASSWORD, 'Renewed1234!').response).status).toBe(204);
            const renewed = await login(user.username, 'Renewed1234!');
            expect(renewed.body.mustChangePassword).toBe(false);
            expect((await h.call('get', '/settings', renewed.body.accessToken).response).status).toBe(200);
        });
    });

    // ── role x action ──────────────────────────────────────────────────────
    describe('role x action matrix', () => {
        const expectedFor = (row: keyof typeof EXPECTED, actor: Actor): number => EXPECTED[row][ACTORS.indexOf(actor)]!;

        it.each(ACTORS)('%s reads only what its role allows', async (actor) => {
            for (const [row, path] of [['readSettings', '/settings'], ['readThresholds', '/settings/alert-thresholds']] as const) {
                const res = await h.call('get', path, tokenOf(actor)).response;
                expect(res.status, path).toBe(expectedFor(row, actor));
                if (res.status !== 200) expect(JSON.stringify(res.body), path).not.toMatch(/password_min_length|slaAlertMinOnTimePct/);
            }
        });

        /** An allowed write changes only its keys and the version; a denied one changes nothing and says who tried. */
        const expectOutcome = async (
            actor: Actor, status: number, expected: number, correlationId: string, before: Record<string, string>,
            changes: Record<string, string>, entityId: string | null, successMetadata: Record<string, unknown>, startedAt: number,
        ) => {
            expect(status).toBe(expected);
            const after = await snapshot();
            const events: AuditRow[] = await h.eventsOf(correlationId);
            if (expected === 200) {
                const nextVersion = Number(before.settings_version) + 1;
                expect(after).toEqual({ ...before, ...changes, settings_version: String(nextVersion) });
                expect(events).toEqual([expect.objectContaining({
                    actor_user_id: actorId(actor as Exclude<Actor, 'anonymous'>), actor_role: actor, action: 'setting.updated',
                    entity_type: 'setting', entity_id: entityId, result: 'success', status_code: 200, correlation_id: correlationId,
                    metadata: { ...successMetadata, settingsVersion: nextVersion },
                })]);
                const occurredAt = new Date((events[0] as AuditRow & { occurred_at: Date }).occurred_at).getTime();
                expect(occurredAt).toBeGreaterThanOrEqual(startedAt - 1_000);
                expect(occurredAt).toBeLessThanOrEqual(Date.now() + 1_000);
                return;
            }
            expect(after).toEqual(before);
            if (actor === 'anonymous') {
                expect(events.filter((event) => event.result === 'success')).toEqual([]);
                return;
            }
            await vi.waitFor(async () => expect(await h.eventsOf(correlationId)).toEqual([expect.objectContaining({
                actor_user_id: actorId(actor), actor_role: actor, action: 'setting.updated', entity_id: entityId,
                result: 'denied', status_code: 403,
            })]));
            const [denial] = await h.eventsOf(correlationId);
            expect(Object.keys(denial!.metadata).filter((key) => key === 'settingsVersion' || key.startsWith('previous'))).toEqual([]);
        };

        const WRITES: Array<[keyof typeof EXPECTED, string, string]> = [
            ['writePasswordPolicy', 'password_min_length', '16'],
            ['writePasswordPolicy', 'password_expiration_days', '45'],
            ...TOGGLES.map((key) => ['writePasswordPolicy', key, 'false'] as [keyof typeof EXPECTED, string, string]),
            ['writeOperationalSetting', 'delivery_window_start', '07:45'],
            ['writeOperationalSetting', 'delivery_window_end', '19:15'],
            ['writeOperationalSetting', 'max_wait_time_min', '27'],
        ];

        describe.each(WRITES)('%s: PUT /settings/%s', (row, key, value) => {
            it.each(ACTORS)('by %s', async (actor) => {
                const before = await snapshot();
                expect(before[key]).not.toBe(value);
                const startedAt = Date.now();
                const { correlationId, response } = putSetting(tokenOf(actor), key, value);
                const res = await response;
                try {
                    await expectOutcome(actor, res.status, expectedFor(row, actor), correlationId, before, { [key]: value }, key,
                        { value, previousValue: before[key] }, startedAt);
                } finally {
                    if (res.status === 200) {
                        expect((await putSetting(rootActor.token, key, before[key]).response).status).toBe(200);
                    }
                }
            });
        });

        it.each(ACTORS)('PUT /settings/alert-thresholds by %s', async (actor) => {
            const before = await snapshot();
            const keys = ['sla_alert_min_on_time_pct', 'gps_stale_alert_minutes', 'driver_incident_alert_per_day'] as const;
            const next = {
                slaAlertMinOnTimePct: Number(before[keys[0]]) - 1,
                gpsStaleAlertMinutes: Number(before[keys[1]]) + 1,
                driverIncidentAlertPerDay: Number(before[keys[2]]) + 1,
            };
            const startedAt = Date.now();
            const { correlationId, response } = h.call('put', '/settings/alert-thresholds', tokenOf(actor), next);
            const res = await response;
            await expectOutcome(actor, res.status, expectedFor('writeThresholds', actor), correlationId, before,
                Object.fromEntries(keys.map((key, index) => [key, String(Object.values(next)[index])])), null,
                {
                    ...next, setting: 'alert-thresholds',
                    previousSlaAlertMinOnTimePct: Number(before[keys[0]]),
                    previousGpsStaleAlertMinutes: Number(before[keys[1]]),
                    previousDriverIncidentAlertPerDay: Number(before[keys[2]]),
                }, startedAt);
        });
    });

    // ── concurrency ────────────────────────────────────────────────────────
    describe('concurrent changes', () => {
        beforeAll(async () => {
            // Keeps each transaction open long enough for the others to overlap: without the row lock they would all
            // read the same version and the same previous value.
            await h.db.query(`CREATE FUNCTION ${slowTrigger}() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(0.04); RETURN NEW; END $$ LANGUAGE plpgsql`);
            await h.db.query(`CREATE TRIGGER ${slowTrigger} BEFORE UPDATE ON settings FOR EACH ROW WHEN (OLD.setting_key <> 'settings_version') EXECUTE FUNCTION ${slowTrigger}()`);
        });
        afterAll(async () => {
            await h.db.query(`DROP TRIGGER IF EXISTS ${slowTrigger} ON settings`);
            await h.db.query(`DROP FUNCTION IF EXISTS ${slowTrigger}()`);
            await setPolicy(CLEAN_DEFAULTS);
        });

        it('simultaneous changes of the same key get consecutive versions and a chain of previous values', async () => {
            const before = await snapshot();
            const values = Array.from({ length: 8 }, (_, index) => String(20 + index));
            const calls = values.map((value) => ({ value, ...putSetting(h.users.admin.token, 'password_min_length', value) }));
            const responses = await Promise.all(calls.map(async (call) => await call.response));
            expect(responses.map((res) => [res.status, res.body.value])).toEqual(values.map((value) => [200, value]));

            const changes = (await Promise.all(calls.map(async (call) => {
                const events = await h.eventsOf(call.correlationId);
                expect(events).toHaveLength(1);
                return events[0]!.metadata as { value: string; previousValue: string; settingsVersion: number };
            }))).sort((a, b) => a.settingsVersion - b.settingsVersion);

            const first = Number(before.settings_version) + 1;
            expect(changes.map((change) => change.settingsVersion)).toEqual(values.map((_, index) => first + index));
            expect(changes.map((change) => change.previousValue))
                .toEqual([before.password_min_length, ...changes.slice(0, -1).map((change) => change.value)]);

            const winner = changes.at(-1)!.value;
            expect(await snapshot()).toEqual({ ...before, password_min_length: winner, settings_version: String(first + values.length - 1) });
            const listed = (await h.call('get', '/settings', h.users.admin.token).response).body as Array<{ key: string; value: string }>;
            expect(listed.find((setting) => setting.key === 'password_min_length')!.value).toBe(winner);
        }, 30_000);

        it('the three owners changing their own settings at once lose nothing', async () => {
            await setPolicy(CLEAN_DEFAULTS);
            const before = await snapshot();
            const thresholds = {
                slaAlertMinOnTimePct: Number(before.sla_alert_min_on_time_pct) - 2,
                gpsStaleAlertMinutes: Number(before.gps_stale_alert_minutes) + 2,
                driverIncidentAlertPerDay: Number(before.driver_incident_alert_per_day) + 2,
            };
            const calls = [
                putSetting(h.users.admin.token, 'password_require_symbol', 'false'),
                putSetting(h.users.admin.token, 'password_expiration_days', '60'),
                putSetting(h.users.coordinator.token, 'max_wait_time_min', '33'),
                putSetting(h.users.coordinator.token, 'delivery_window_end', '19:45'),
                h.call('put', '/settings/alert-thresholds', h.users.supervisor.token, thresholds),
            ];
            const statuses = await Promise.all(calls.map(async (call) => (await call.response).status));
            expect(statuses).toEqual([200, 200, 200, 200, 200]);

            const first = Number(before.settings_version) + 1;
            expect(await snapshot()).toEqual({
                ...before, password_require_symbol: 'false', password_expiration_days: '60', max_wait_time_min: '33', delivery_window_end: '19:45',
                sla_alert_min_on_time_pct: String(thresholds.slaAlertMinOnTimePct), gps_stale_alert_minutes: String(thresholds.gpsStaleAlertMinutes),
                driver_incident_alert_per_day: String(thresholds.driverIncidentAlertPerDay), settings_version: String(first + 4),
            });
            const versions = await Promise.all(calls.map(async (call) => (await h.eventsOf(call.correlationId))[0]!.metadata.settingsVersion as number));
            expect([...versions].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4].map((offset) => first + offset));

            for (const key of ['max_wait_time_min', 'delivery_window_end', 'sla_alert_min_on_time_pct', 'gps_stale_alert_minutes', 'driver_incident_alert_per_day']) {
                await h.db.query('UPDATE settings SET setting_value = $2 WHERE setting_key = $1', [key, before[key]]);
            }
        }, 30_000);
    });

    // ── reload ─────────────────────────────────────────────────────────────
    // Keep this block last: passport keeps one global 'jwt' strategy, so booting a second application points the
    // authentication of the first one at it.
    describe('state after a restart', () => {
        it('a second instance of the service started afterwards reads and enforces what was saved', async () => {
            await setPolicy({ password_min_length: '18', password_require_symbol: 'false' });
            const restarted = new AuditE2eHarness('pwrestart');
            try {
                await restarted.start([]);
                const stored = await snapshot();
                const listed = (await restarted.call('get', '/settings', h.users.admin.token).response).body as Array<{ key: string; value: string }>;
                expect(Object.fromEntries(listed.map(({ key, value }) => [key, value])))
                    .toEqual(Object.fromEntries(Object.entries(stored).filter(([key]) => key !== 'settings_version')));

                const username = newUsername();
                const short = await restarted.call('post', '/users', h.users.admin.token, newUserBody(username, 'Abcdefghij1!')).response;
                expect([short.status, short.body.error]).toEqual([400, 'PASSWORD_TOO_SHORT']);
                const ok = await restarted.call('post', '/users', h.users.admin.token, newUserBody(username, 'AbcdefghijAbcdef12')).response;
                expect(ok.status).toBe(201);
            } finally {
                await restarted.close();
            }
        }, 60_000);
    });
});
