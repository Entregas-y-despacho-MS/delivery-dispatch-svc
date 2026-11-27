// RF-A25: no text other than the stored password logs in, against the real AppModule and database. It covers what
// bcrypt alone gets wrong (only 72 bytes read, the NUL cycle, lone surrogates), the reuse check, and the accounts
// whose hash was made before the pre-hash. The setting it changes is restored in afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { AuditE2eHarness } from './helpers/audit-e2e.harness.js';

const ASCII_128 = 'Aa1!bcdefghijklm'.repeat(8);

describe('a password is matched whole (RF-A25)', () => {
    const h = new AuditE2eHarness('pwhash');
    let originalMinimum = '';
    let sequence = 0;
    let address = 0;

    const setMinimum = async (value: string) => {
        expect((await h.call('put', '/settings/password_min_length', h.users.admin.token, { value }).response).status).toBe(200);
    };
    // Every request comes from its own address: the login endpoints are rate limited per IP.
    const post = (path: string, body: object, token?: string) => {
        const call = request(h.app.getHttpServer()).post(`/${h.api}${path}`).set('X-Forwarded-For', `10.1.${++address % 250}.${address % 200}`);
        if (token) call.set('Authorization', `Bearer ${token}`);
        return call.send(body);
    };
    const patch = (path: string, body: object, token: string) => h.call('patch', path, token, body).response;
    const login = (username: string, password: string) => post('/auth/login', { username, password });
    const clearFailures = (id: number) => h.db.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1', [id]);
    const createUser = async (password: string) => {
        const username = `${h.prefix}-u${++sequence}`;
        const res = await h.call('post', '/users', h.users.admin.token, { fullName: 'E2E hash', username, password, roleId: h.roles.driver }).response;
        return { res, username, id: res.body.id as number };
    };
    const storedHash = async (id: number): Promise<string> =>
        (await h.db.query('SELECT password_hash FROM users WHERE user_id = $1', [id]))[0].password_hash;
    const expectOnly = async (username: string, id: number, password: string, others: string[]) => {
        for (const other of others) {
            await clearFailures(id);
            const res = await login(username, other);
            // A NUL byte never gets to the comparison: the global NoNullBytesPipe answers 400 first.
            const hasNul = other.includes('\0');
            expect(res.status, JSON.stringify(other)).toBe(hasNul ? 400 : 401);
            if (!hasNul) expect(res.body.error).toBe('INVALID_CREDENTIALS');
            expect(res.body.accessToken).toBeUndefined();
        }
        await clearFailures(id);
        expect((await login(username, password)).status, 'the exact password').toBe(200);
    };

    beforeAll(async () => {
        await h.start(['admin']);
        h.app.getHttpAdapter().getInstance().set('trust proxy', true);
        originalMinimum = (await h.db.query("SELECT setting_value FROM settings WHERE setting_key = 'password_min_length'"))[0].setting_value;
    }, 60_000);

    afterAll(async () => {
        if (h.db?.isInitialized) {
            await h.db.query("UPDATE settings SET setting_value = $1 WHERE setting_key = 'password_min_length'", [originalMinimum]);
        }
        await h.close();
    });

    it('with a minimum of 128: changing or dropping anything after byte 72 does not log in', async () => {
        await setMinimum('128');
        try {
            const { res, username, id } = await createUser(ASCII_128);
            expect(res.status).toBe(201);
            expect(await storedHash(id)).toMatch(/^bcrypt-sha384:\$2b\$10\$/);
            await expectOnly(username, id, ASCII_128, [
                ASCII_128.slice(0, 72) + 'z'.repeat(56), ASCII_128.slice(0, 72), ASCII_128.slice(0, 127), `${ASCII_128}x`,
            ]);
        } finally {
            await setMinimum(originalMinimum);
        }
    }, 60_000);

    it.each([
        ['255 characters, the DTO limit', 'Aa1!x'.repeat(51), ['Aa1!x'.repeat(50) + 'Aa1!y', 'Aa1!x'.repeat(15)]],
        ['multibyte text past byte 72', `Aa1!${'ñ'.repeat(40)}`, [`Aa1!${'ñ'.repeat(34)}`, `Aa1!${'ñ'.repeat(40)}x`]],
        ['a short one, against NUL and spaces', 'Abc1!xyz', ['Abc1!xyz\0Abc1!xyz', 'Abc1!xyz\0', 'Abc1!xyz ']],
    ])('%s: only the exact text logs in', async (_name, password, others) => {
        const { res, username, id } = await createUser(password);
        expect(res.status).toBe(201);
        await expectOnly(username, id, password, others);
    }, 60_000);

    describe('NUL bytes, lone surrogates and U+FFFD cannot be set', () => {
        const surrogates = ['Abc1!xyz\uD800', 'Abc1!xyz\uDC00z', 'Abc1!xyz\uFFFD'];

        it.each(surrogates)('%j: rejected on create, nothing saved', async (password) => {
            const { res, username } = await createUser(password);
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('PASSWORD_INVALID_CHARACTERS');
            expect(await h.db.query('SELECT 1 FROM users WHERE username = $1', [username])).toHaveLength(0);
        });

        // A client that sends latin-1: the parser turns each such byte into U+FFFD, whichever it was.
        const latin1 = (body: object) => Buffer.from(JSON.stringify(body), 'latin1');
        const postBytes = (path: string, body: Buffer, token?: string) => {
            const call = request(h.app.getHttpServer()).post(`/${h.api}${path}`)
                .set('X-Forwarded-For', `10.2.${++address % 250}.${address % 200}`).set('Content-Type', 'application/json');
            if (token) call.set('Authorization', `Bearer ${token}`);
            call.write(body);
            return call;
        };

        it('bytes that are not valid UTF-8 cannot be set, so two different ones never open the same account', async () => {
            const username = `${h.prefix}-u${++sequence}`;
            const body = latin1({ fullName: 'E2E hash', username, password: 'Contrase\u00f1a1!', roleId: h.roles.driver });
            const res = await postBytes('/users', body, h.users.admin.token!);
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('PASSWORD_INVALID_CHARACTERS');
            expect(await h.db.query('SELECT 1 FROM users WHERE username = $1', [username])).toHaveLength(0);

            const user = await createUser('Contrase\u00f1a1!');
            expect(user.res.status).toBe(201);
            const other = await postBytes('/auth/login', latin1({ username: user.username, password: 'Contrase\u00f3a1!' }));
            expect(other.status).toBe(401);
        });

        it('a NUL byte is rejected on create by the global pipe, nothing saved', async () => {
            const { res, username } = await createUser('Abc1!xyz\0Abc1!xyz');
            expect(res.status).toBe(400);
            expect(await h.db.query('SELECT 1 FROM users WHERE username = $1', [username])).toHaveLength(0);
        });

        it('both are rejected on admin update and on own change, and the hash stays', async () => {
            const { username, id } = await createUser('Passw0rd!Original');
            const before = await storedHash(id);
            const token = (await login(username, 'Passw0rd!Original')).body.accessToken as string;
            const change = (newPassword: string) => patch('/auth/change-password', { currentPassword: 'Passw0rd!Original', newPassword }, token);
            for (const password of [surrogates[0], 'Abc1!xyz\0Abc1!xyz']) {
                const update = await h.call('put', `/users/${id}`, h.users.admin.token, { password }).response;
                expect(update.status).toBe(400);
                const own = await change(password);
                expect(own.status).toBe(400);
                if (!password.includes('\0')) {
                    expect(update.body.error).toBe('PASSWORD_INVALID_CHARACTERS');
                    expect(own.body.error).toBe('PASSWORD_INVALID_CHARACTERS');
                }
            }
            expect(await storedHash(id)).toBe(before);
        }, 60_000);
    });

    it('change-password: the current one must be exact, and one differing only after byte 72 is not a reuse', async () => {
        const first = `${'Aa1!'.repeat(18)}Uno1!`;
        const second = `${'Aa1!'.repeat(18)}Dos2!`;
        const { username, id } = await createUser(first);
        const token = (await login(username, first)).body.accessToken as string;

        const wrong = await patch('/auth/change-password', { currentPassword: second, newPassword: 'OtraClave1!' }, token);
        expect(wrong.status).toBe(401);
        const same = await patch('/auth/change-password', { currentPassword: first, newPassword: first }, token);
        expect(same.body.error).toBe('PASSWORD_RECENTLY_USED');
        const changed = await patch('/auth/change-password', { currentPassword: first, newPassword: second }, token);
        expect(changed.status, JSON.stringify(changed.body)).toBe(204);
        await expectOnly(username, id, second, [first]);

        // The one just replaced is now in the history.
        const again = (await login(username, second)).body.accessToken as string;
        const reused = await patch('/auth/change-password', { currentPassword: second, newPassword: first }, again);
        expect(reused.body.error).toBe('PASSWORD_RECENTLY_USED');
    }, 60_000);

    describe('accounts with a hash from before (bcrypt on the text itself)', () => {
        const withLegacyHash = async (password: string) => {
            const { username, id } = await createUser('Temporal1!pass');
            await h.db.query('UPDATE users SET password_hash = $2, requires_pwd_change = false WHERE user_id = $1', [id, await bcrypt.hash(password, 10)]);
            return { username, id };
        };

        it.each([['a common one', 'Passw0rd!Legacy'], ['one of 71 bytes', `Aa1!${'b'.repeat(67)}`]])('%s still logs in, and only exactly', async (_name, password) => {
            const { username, id } = await withLegacyHash(password);
            await expectOnly(username, id, password, [`${password}x`, `${password}\0${password}`, password.slice(0, -1)]);
        }, 60_000);

        it('one of 72 bytes or more no longer logs in with any text; an admin reset restores the access', async () => {
            const { username, id } = await withLegacyHash(ASCII_128);
            for (const candidate of [ASCII_128, ASCII_128.slice(0, 72), ASCII_128.slice(0, 72) + 'z'.repeat(56), ASCII_128.slice(0, 71)]) {
                await clearFailures(id);
                expect((await login(username, candidate)).status, candidate).toBe(401);
            }
            expect((await h.call('put', `/users/${id}`, h.users.admin.token, { password: ASCII_128 }).response).status).toBe(200);
            await expectOnly(username, id, ASCII_128, [ASCII_128.slice(0, 72)]);
        }, 60_000);

        it.each([['a common one', 'Passw0rd!Vieja'], ['one longer than 72 bytes', ASCII_128]])('the older hash kept in the history still blocks that password: %s', async (_name, old) => {
            const { username, id } = await createUser('Passw0rd!Actual');
            await h.db.query('INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)', [id, await bcrypt.hash(old, 10)]);
            const token = (await login(username, 'Passw0rd!Actual')).body.accessToken as string;
            const res = await patch('/auth/change-password', { currentPassword: 'Passw0rd!Actual', newPassword: old }, token);
            expect(res.body.error).toBe('PASSWORD_RECENTLY_USED');
        }, 60_000);
    });
});
