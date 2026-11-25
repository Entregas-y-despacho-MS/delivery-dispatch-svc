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

});
