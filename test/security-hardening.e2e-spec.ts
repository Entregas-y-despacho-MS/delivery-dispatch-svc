// Regression tests, against a real database, for problems found reviewing the whole backend:
//  - refresh token rotation did not work (a rotated token kept working);
//  - parallel wrong passwords never locked the account, and one typo after a lock re-locked it;
//  - an admin could become root (create a root user, reset root's password, promote themselves, delete root);
//  - 2FA could be re-enrolled while enabled (secret swapped without the password);
//  - settings accepted any text (a negative inactivity limit closed every session);
//  - integers above INTEGER, page numbers beyond OFFSET, and NUL characters were 500s;
//  - a concurrent create with the same username / zone code was a 500;
//  - emails were case-sensitive;
//  - sync: a driver could touch any dispatch; unknown references were "Unexpected error."; evidences accepted
//    anything (HTML files served from the API's origin, no size limit, a photo without a file).
// Self-cleaning (unique run tag), safe to re-run against a shared database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { OTP } from 'otplib';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { MailerPort } from '../src/plugins/mailer/mailer.port.js';

const PASSWORD = 'E2eTest1234';

describe('Security hardening (e2e)', () => {
    let app: INestApplication;
    let ds: DataSource;
    let prefix: string;
    const roles: Record<string, number> = {};
    const tokens: Record<string, string> = {};
    const mails: { to: string; html: string }[] = [];
    const run = Date.now().toString(36);

    const api = (p: string) => `/${prefix}${p}`;
    const http = () => request(app.getHttpServer());
    const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
    const login = (username: string, password = PASSWORD, totpCode?: string) => http().post(api('/auth/login')).send({ username, password, ...(totpCode && { totpCode }) });
    const mkUser = async (role: string, tag: string, email?: string) => {
        const username = `hd_${tag}_${run}`;
        const [{ user_id }] = await ds.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change, email) VALUES ($1,$2,$3,$4,false,$5) RETURNING user_id`,
            [roles[role], `HD ${tag}`, username, await hashPassword(PASSWORD), email ?? null],
        );
        return { id: user_id as number, username };
    };
    const userRow = async (id: number) => (await ds.query(`SELECT * FROM users WHERE user_id = $1`, [id]))[0];

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(MailerPort).useValue({ send: (o: any) => { mails.push(o); } })
            .compile();
        app = moduleRef.createNestApplication();
        prefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(prefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        ds = moduleRef.get(DataSource);
        for (const r of await ds.query(`SELECT role_id, name FROM roles`)) roles[r.name] = r.role_id;
        for (const role of ['root', 'admin', 'coordinator', 'supervisor', 'driver']) {
            await mkUser(role, `base_${role}`);
            tokens[role] = (await login(`hd_base_${role}_${run}`)).body.accessToken;
        }
    });

    afterAll(async () => {
        await ds.query(`DELETE FROM dispatch_events    WHERE dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE source_order_ref LIKE $1)`, [`hd-${run}%`]);
        await ds.query(`DELETE FROM dispatch_incidents WHERE dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE source_order_ref LIKE $1)`, [`hd-${run}%`]);
        await ds.query(`DELETE FROM delivery_evidences WHERE dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE source_order_ref LIKE $1)`, [`hd-${run}%`]);
        await ds.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`hd-${run}%`]);
        await ds.query(`DELETE FROM route_batches WHERE driver_id IN (SELECT user_id FROM users WHERE username LIKE $1)`, [`hd\\_%\\_${run}`]);
        await ds.query(`DELETE FROM delivery_zones WHERE code LIKE $1`, [`HD${run}%`]);
        await ds.query(`DELETE FROM password_history WHERE user_id IN (SELECT user_id FROM users WHERE username LIKE $1 OR username LIKE $2)`, [`hd\\_%\\_${run}`, `%\\_${run}`]);
        await ds.query(`DELETE FROM users WHERE username LIKE $1 OR username LIKE $2`, [`hd\\_%\\_${run}`, `hdn\\_%\\_${run}`]);
        await ds.query(`UPDATE settings SET setting_value = $1 WHERE setting_key = 'max_wait_time_min' AND setting_value = '20'`, ['15']);
        await app.close();
    });

    // ── refresh token rotation ─────────────────────────────────────────────────
    describe('refresh token rotation', () => {
        it('a rotated (old) refresh token is rejected, and reusing it closes every session', async () => {
            const u = await mkUser('coordinator', 'rot');
            const first = (await login(u.username)).body.refreshToken as string;
            const rotated = await http().post(api('/auth/refresh')).send({ refreshToken: first });
            expect(rotated.status).toBe(200);
            expect(rotated.body.refreshToken).not.toBe(first);

            const reuse = await http().post(api('/auth/refresh')).send({ refreshToken: first });
            expect(reuse.status).toBe(401);
            expect(reuse.body.error).toBe('INVALID_REFRESH_TOKEN');

            // Reuse means the token was probably stolen: the legitimate new token is revoked too.
            const afterReuse = await http().post(api('/auth/refresh')).send({ refreshToken: rotated.body.refreshToken });
            expect(afterReuse.status).toBe(401);
        });

        it('the current token keeps rotating normally, also when two are issued within the same second', async () => {
            const u = await mkUser('coordinator', 'rot2');
            let token = (await login(u.username)).body.refreshToken as string;
            for (let i = 0; i < 3; i++) {
                const res = await http().post(api('/auth/refresh')).send({ refreshToken: token });
                expect(res.status).toBe(200);
                expect(res.body.refreshToken).not.toBe(token);
                token = res.body.refreshToken;
            }
        });

        it('what is stored is a SHA-256 fingerprint, never the token itself', async () => {
            const u = await mkUser('coordinator', 'rot3');
            const token = (await login(u.username)).body.refreshToken as string;
            const stored = (await userRow(u.id)).refresh_token_hash as string;
            expect(stored).toMatch(/^[0-9a-f]{64}$/);
            expect(stored).not.toContain(token.slice(0, 20));
        });

        it('logout revokes the refresh token', async () => {
            const u = await mkUser('coordinator', 'rot4');
            const l = await login(u.username);
            await http().post(api('/auth/logout')).set({ Authorization: `Bearer ${l.body.accessToken}` }).expect(204);
            expect((await http().post(api('/auth/refresh')).send({ refreshToken: l.body.refreshToken })).status).toBe(401);
        });
    });

    // ── account lockout ────────────────────────────────────────────────────────
    describe('account lockout (RF-A21)', () => {
        it('parallel wrong passwords all count: the account locks (it used to stay at 1 attempt and never lock)', async () => {
            const u = await mkUser('coordinator', 'lock1');
            const results = await Promise.all(Array.from({ length: 12 }, () => login(u.username, 'Wrong-Passw0rd!')));
            expect(results.every((r) => r.status === 401)).toBe(true);

            const row = await userRow(u.id);
            expect(row.failed_attempts).toBe(12);
            expect(row.locked_until).not.toBeNull();

            const correct = await login(u.username);
            expect(correct.status).toBe(401);
            expect(correct.body.error).toBe('ACCOUNT_LOCKED');
        });

        it('locks exactly at the configured limit (5): 4 wrong attempts do not lock, the 5th does', async () => {
            const u = await mkUser('coordinator', 'lock2');
            for (let i = 1; i <= 4; i++) {
                await login(u.username, 'Wrong-Passw0rd!');
                expect((await userRow(u.id)).locked_until, `attempt ${i}`).toBeNull();
            }
            await login(u.username, 'Wrong-Passw0rd!');
            const row = await userRow(u.id);
            expect(row.failed_attempts).toBe(5);
            expect(new Date(row.locked_until).getTime()).toBeGreaterThan(Date.now());
        });

        it('once the lock has expired the count starts over: one typo does not lock again, the right password works', async () => {
            const u = await mkUser('coordinator', 'lock3');
            for (let i = 0; i < 5; i++) await login(u.username, 'Wrong-Passw0rd!');
            await ds.query(`UPDATE users SET locked_until = now() - interval '1 minute' WHERE user_id = $1`, [u.id]);

            await login(u.username, 'Wrong-Passw0rd!');
            const row = await userRow(u.id);
            expect(row.failed_attempts).toBe(1);
            expect(row.locked_until).toBeNull();

            expect((await login(u.username)).status).toBe(200);
            expect((await userRow(u.id)).failed_attempts).toBe(0);
        });
    });

    // ── root is protected from admins ──────────────────────────────────────────
    describe('an admin cannot become root', () => {
        const forbidden = (res: request.Response) => {
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('ROOT_ACCOUNT_PROTECTED');
        };

        it('cannot create a user with the root role (POST /users and POST /auth/register)', async () => {
            const before = (await ds.query(`SELECT count(*)::int AS c FROM users`))[0].c;
            forbidden(await http().post(api('/users')).set(auth('admin')).send({ fullName: 'X', username: `hdn_a_${run}`, password: 'Passw0rd!', roleId: roles.root }));
            forbidden(await http().post(api('/auth/register')).set(auth('admin')).send({ fullName: 'X', username: `hdn_b_${run}`, password: 'Passw0rd!', roleId: roles.root }));
            expect((await ds.query(`SELECT count(*)::int AS c FROM users`))[0].c).toBe(before);
        });

        it('cannot promote themselves (or anyone) to root', async () => {
            const adminId = (await ds.query(`SELECT user_id FROM users WHERE username = $1`, [`hd_base_admin_${run}`]))[0].user_id;
            forbidden(await http().patch(api(`/users/${adminId}/role`)).set(auth('admin')).send({ roleId: roles.root }));
            expect((await userRow(adminId)).role_id).toBe(roles.admin);
        });

        it('cannot reset the password of, edit or delete a root account', async () => {
            const root = await mkUser('root', 'victim');
            forbidden(await http().put(api(`/users/${root.id}`)).set(auth('admin')).send({ password: 'Hacked1234!' }));
            forbidden(await http().put(api(`/users/${root.id}`)).set(auth('admin')).send({ active: false }));
            forbidden(await http().delete(api(`/users/${root.id}`)).set(auth('admin')));

            expect((await login(root.username, 'Hacked1234!')).status).toBe(401);
            const row = await userRow(root.id);
            expect(row.deleted_at).toBeNull();
            expect(row.active).toBe(true);
            expect((await login(root.username)).status).toBe(200);
        });

        it('root itself can manage root accounts and assign the root role', async () => {
            const created = await http().post(api('/users')).set(auth('root')).send({ fullName: 'Second Root', username: `hd_root2_${run}`, password: 'Passw0rd!', roleId: roles.root });
            expect(created.status).toBe(201);
            expect(created.body.role.name).toBe('root');
            expect((await http().put(api(`/users/${created.body.id}`)).set(auth('root')).send({ fullName: 'Renamed Root' })).status).toBe(200);
            expect((await http().delete(api(`/users/${created.body.id}`)).set(auth('root'))).status).toBe(204);
        });

        it('an admin still manages every other account normally', async () => {
            const created = await http().post(api('/users')).set(auth('admin')).send({ fullName: 'Driver', username: `hd_drv_${run}`, password: 'Passw0rd!', roleId: roles.driver });
            expect(created.status).toBe(201);
            expect((await http().patch(api(`/users/${created.body.id}/role`)).set(auth('admin')).send({ roleId: roles.supervisor })).status).toBe(200);
            expect((await http().delete(api(`/users/${created.body.id}`)).set(auth('admin'))).status).toBe(204);
        });

        it('a nonexistent user is still a plain 404 for an admin', async () => {
            expect((await http().put(api('/users/99999999')).set(auth('admin')).send({ fullName: 'x' })).status).toBe(404);
        });
    });

    // ── 2FA ────────────────────────────────────────────────────────────────────
    describe('2FA enrolment', () => {
        it('cannot be started again while enabled (the secret would be swapped without the password)', async () => {
            const u = await mkUser('coordinator', 'tfa');
            const H = { Authorization: `Bearer ${(await login(u.username)).body.accessToken}` };
            const enable = await http().post(api('/auth/2fa/enable')).set(H).send({ password: PASSWORD });
            expect(enable.status).toBe(200);
            const code = await new OTP({ strategy: 'totp' }).generate({ secret: enable.body.secret });
            await http().post(api('/auth/2fa/confirm')).set(H).send({ code }).expect(204);

            const again = await http().post(api('/auth/2fa/enable')).set(H).send({ password: PASSWORD });
            expect(again.status).toBe(409);
            expect(again.body.error).toBe('TWO_FACTOR_ALREADY_ENABLED');

            // The owner's authenticator still works: the secret was not replaced.
            const okCode = await new OTP({ strategy: 'totp' }).generate({ secret: enable.body.secret });
            expect((await login(u.username, PASSWORD, okCode)).status).toBe(200);
        });

        it('can be started again before it is confirmed, and after disabling it', async () => {
            const u = await mkUser('coordinator', 'tfb');
            const H = { Authorization: `Bearer ${(await login(u.username)).body.accessToken}` };
            const first = await http().post(api('/auth/2fa/enable')).set(H).send({ password: PASSWORD });
            const second = await http().post(api('/auth/2fa/enable')).set(H).send({ password: PASSWORD });
            expect([first.status, second.status]).toEqual([200, 200]);

            const code = await new OTP({ strategy: 'totp' }).generate({ secret: second.body.secret });
            await http().post(api('/auth/2fa/confirm')).set(H).send({ code }).expect(204);
            await http().post(api('/auth/2fa/disable')).set(H).send({ password: PASSWORD }).expect(204);
            expect((await http().post(api('/auth/2fa/enable')).set(H).send({ password: PASSWORD })).status).toBe(200);
        });
    });

    // ── settings ───────────────────────────────────────────────────────────────
    describe('settings values are validated', () => {
        const put = (key: string, value: string) => http().put(api(`/settings/${key}`)).set(auth('admin')).send({ value });

        it.each([
            ['max_failed_login_attempts', 'abc'], ['max_failed_login_attempts', '0'], ['session_inactivity_minutes', '-5'],
            ['password_min_length', '0'], ['sla_alert_threshold_pct', '150'], ['delivery_window_start', '25:00'], ['account_lockout_minutes', '1.5'],
        ])('%s = %j → 400 INVALID_SETTING_VALUE and the value is not stored', async (key, value) => {
            const before = (await ds.query(`SELECT setting_value FROM settings WHERE setting_key = $1`, [key]))[0].setting_value;
            const res = await put(key, value);

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('INVALID_SETTING_VALUE');
            expect(res.body.message).toContain(key);
            expect((await ds.query(`SELECT setting_value FROM settings WHERE setting_key = $1`, [key]))[0].setting_value).toBe(before);
        });

        it('a valid value is stored', async () => {
            const res = await put('max_wait_time_min', '20');
            expect(res.status).toBe(200);
            expect(res.body.value).toBe('20');
            await put('max_wait_time_min', '15');
        });

        it('an unknown key is a 404', async () => {
            expect((await put('no_such_setting', '1')).status).toBe(404);
        });
    });

    // ── values that used to be a 500 ───────────────────────────────────────────
    describe('no more 500 for out-of-range numbers and NUL characters', () => {
        it.each(['users', 'roles', 'delivery-zones', 'vehicles', 'service-levels'])('GET /%s/:id with an id above INTEGER, 0 or negative → 400', async (path) => {
            const who = { users: 'admin', roles: 'admin', 'delivery-zones': 'coordinator', vehicles: 'supervisor', 'service-levels': 'coordinator' }[path]!;
            for (const id of ['99999999999', '2147483648', '0', '-1']) {
                const res = await http().get(api(`/${path}/${id}`)).set(auth(who));
                expect(res.status, `${path}/${id}`).toBe(400);
            }
            expect((await http().get(api(`/${path}/2147483647`)).set(auth(who))).status).toBe(404); // the largest valid id: just not found
        });

        it.each([
            ['PUT', 'users', 'admin'], ['DELETE', 'users', 'admin'], ['PUT', 'vehicles', 'supervisor'], ['DELETE', 'delivery-zones', 'coordinator'], ['PUT', 'service-levels', 'coordinator'],
        ])('%s /%s/99999999999 → 400', async (method, path, who) => {
            const res = await (http() as any)[method.toLowerCase()](api(`/${path}/99999999999`)).set(auth(who)).send({});
            expect(res.status).toBe(400);
        });

        it('list params: a huge page, a role/status id above INTEGER, or a NUL in the search → 400', async () => {
            const cases: [string, string, string][] = [
                ['users', 'admin', 'page=1e18'], ['users', 'admin', 'limit=100&page=92233720368547758'], ['users', 'admin', 'roleId=99999999999'], ['users', 'admin', 'search=%00'],
                ['roles', 'admin', 'search=%00'], ['delivery-zones', 'coordinator', 'page=1000001'], ['delivery-zones', 'coordinator', 'search=a%00b'],
                ['vehicles', 'supervisor', 'vehicleStatusId=99999999999'], ['vehicles', 'supervisor', 'search=%00'], ['service-levels', 'coordinator', 'search=%00'],
            ];
            for (const [path, who, qs] of cases) {
                expect((await http().get(api(`/${path}?${qs}`)).set(auth(who))).status, `${path}?${qs}`).toBe(400);
            }
            expect((await http().get(api('/users?page=1000000')).set(auth('admin'))).status).toBe(200); // the largest page is still fine
        });

        it('bodies: ids above INTEGER and NUL characters → 400', async () => {
            const big = 99999999999;
            const cases: [string, string, string, object][] = [
                ['post', 'users', 'admin', { fullName: 'x', username: `hdn_big_${run}`, password: 'Passw0rd!', roleId: big }],
                ['post', 'users', 'admin', { fullName: 'x', username: `hdn_nul_${run}\u0000`, password: 'Passw0rd!', roleId: roles.driver }],
                ['post', 'users', 'admin', { fullName: 'x\u0000', username: `hdn_nul2_${run}`, password: 'Passw0rd!', roleId: roles.driver }],
                ['post', 'delivery-zones', 'coordinator', { code: `HD${run}Z`, name: 'n', estimatedTimeMin: big }],
                ['post', 'delivery-zones', 'coordinator', { code: `HD${run}\u0000`, name: 'n', estimatedTimeMin: 5 }],
                ['post', 'vehicles', 'supervisor', { type: 't', model: 'm', plate: `HD${run}\u0000`, capacityKg: 1, capacityM3: 1 }],
                ['put', 'vehicles/1', 'supervisor', { vehicleStatusId: big }],
                ['post', 'service-levels', 'coordinator', { name: `hd${run}\u0000`, targetTimeMin: 20, priorityLevel: 1 }],
                ['put', 'settings/max_wait_time_min', 'admin', { value: 'a\u0000b' }],
            ];
            for (const [method, path, who, body] of cases) {
                const res = await (http() as any)[method](api(`/${path}`)).set(auth(who)).send(body);
                expect(res.status, `${method} ${path}`).toBe(400);
            }
        });

        it('public endpoints too: a NUL character in login or reset-password → 400 (login used to be a 500)', async () => {
            expect((await http().post(api('/auth/login')).send({ username: 'a\u0000', password: 'y' })).status).toBe(400);
            expect((await http().post(api('/auth/reset-password')).send({ token: 'a\u0000', newPassword: 'Passw0rd!x' })).status).toBe(400);
        });

        it('a NUL character in the URL path is also a 400', async () => {
            expect((await http().put(api('/settings/max%00wait')).set(auth('admin')).send({ value: '1' })).status).toBe(400);
        });
    });

    // ── concurrent duplicates ──────────────────────────────────────────────────
    describe('two requests at once with the same unique value', () => {
        const tally = (rs: request.Response[]) => rs.reduce((a: Record<number, number>, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});

        it('same username: exactly one is created, the rest are 409 (they used to be 500)', async () => {
            const body = { fullName: 'Same', username: `hd_same_${run}`, password: 'Passw0rd!', roleId: roles.driver };
            const rs = await Promise.all(Array.from({ length: 8 }, () => http().post(api('/users')).set(auth('admin')).send(body)));
            expect(tally(rs)).toEqual({ 201: 1, 409: 7 });
        });

        it('same delivery zone code: exactly one is created, the rest are 409', async () => {
            const body = { code: `HD${run}C`, name: 'Zone', estimatedTimeMin: 20 };
            const rs = await Promise.all(Array.from({ length: 8 }, () => http().post(api('/delivery-zones')).set(auth('coordinator')).send(body)));
            expect(tally(rs)).toEqual({ 201: 1, 409: 7 });
        });
    });

    // ── email case ─────────────────────────────────────────────────────────────
    describe('emails are case-insensitive', () => {
        it('stored in lowercase; the same address in another case is a duplicate', async () => {
            const first = await http().post(api('/users')).set(auth('admin')).send({ fullName: 'E', username: `hd_em1_${run}`, email: `Case.${run}@Example.COM`, password: 'Passw0rd!', roleId: roles.driver });
            expect(first.status).toBe(201);
            expect(first.body.email).toBe(`case.${run}@example.com`);

            const dup = await http().post(api('/users')).set(auth('admin')).send({ fullName: 'E', username: `hd_em2_${run}`, email: `CASE.${run}@example.com`, password: 'Passw0rd!', roleId: roles.driver });
            expect(dup.status).toBe(409);
            expect(dup.body.error).toBe('USER_ALREADY_EXISTS');
        });

        it('forgot-password finds the account whatever case is typed (also for rows saved with capitals before)', async () => {
            const legacy = await mkUser('coordinator', 'em3', `Legacy.${run}@Example.com`); // stored as typed, like old data
            mails.length = 0;

            await http().post(api('/auth/forgot-password')).send({ email: `LEGACY.${run}@EXAMPLE.COM` }).expect(204);

            expect(mails).toHaveLength(1);
            const token = mails[0].html.match(/[0-9a-f]{64}/)![0];
            expect((await http().post(api('/auth/reset-password')).send({ token, newPassword: 'BrandNew1234!' })).status).toBe(204);
            expect((await login(legacy.username, 'BrandNew1234!')).status).toBe(200);
        });

        it('editing to null still clears the email', async () => {
            const u = await http().post(api('/users')).set(auth('admin')).send({ fullName: 'E', username: `hd_em4_${run}`, email: `clear.${run}@x.com`, password: 'Passw0rd!', roleId: roles.driver });
            const res = await http().put(api(`/users/${u.body.id}`)).set(auth('admin')).send({ email: null });
            expect(res.status).toBe(200);
            expect(res.body.email).toBeNull();
        });
    });

    // ── the access token is checked against the database ───────────────────────
    describe('an access token is only as good as its user is now', () => {
        const get = (token: string) => http().get(api('/roles')).set({ Authorization: `Bearer ${token}` });

        it('deactivating the user closes their access token on the very next request', async () => {
            const u = await mkUser('coordinator', 'tk1');
            const token = (await login(u.username)).body.accessToken as string;
            expect((await get(token)).status).toBe(200);

            await http().put(api(`/users/${u.id}`)).set(auth('admin')).send({ active: false }).expect(200);

            const res = await get(token);
            expect(res.status).toBe(401);
            expect(res.body.error).toBe('INVALID_TOKEN');
        });

        it('deleting the user closes it too', async () => {
            const u = await mkUser('coordinator', 'tk2');
            const token = (await login(u.username)).body.accessToken as string;
            await http().delete(api(`/users/${u.id}`)).set(auth('admin')).expect(204);
            expect((await get(token)).status).toBe(401);
        });

        it('a role change applies at once: a token minted as admin stops being admin', async () => {
            const u = await mkUser('admin', 'tk3');
            const token = (await login(u.username)).body.accessToken as string;
            expect((await http().get(api('/settings')).set({ Authorization: `Bearer ${token}` })).status).toBe(200);

            await http().patch(api(`/users/${u.id}/role`)).set(auth('admin')).send({ roleId: roles.driver }).expect(200);

            expect((await http().get(api('/settings')).set({ Authorization: `Bearer ${token}` })).status).toBe(403);
        });

        it('a password change closes the access tokens issued before it (also one stolen earlier)', async () => {
            const u = await mkUser('coordinator', 'tk4');
            const stolen = (await login(u.username)).body.accessToken as string;
            await new Promise((r) => setTimeout(r, 1100)); // the JWT clock has second resolution

            await http().put(api(`/users/${u.id}`)).set(auth('admin')).send({ password: 'NewSecret1234!' }).expect(200);

            expect((await get(stolen)).status).toBe(401);
            const fresh = (await login(u.username, 'NewSecret1234!')).body.accessToken as string;
            expect((await get(fresh)).status).toBe(200);
        });

        it('the user\'s own change-password also closes the current token (they must log in again)', async () => {
            const u = await mkUser('coordinator', 'tk5');
            const token = (await login(u.username)).body.accessToken as string;
            await new Promise((r) => setTimeout(r, 1100));
            await http().patch(api('/auth/change-password')).set({ Authorization: `Bearer ${token}` }).send({ currentPassword: PASSWORD, newPassword: 'OtherSecret1234!' }).expect(204);
            expect((await get(token)).status).toBe(401);
        });
    });

    // ── a password change is enforced, not just suggested ──────────────────────
    describe('an account that must change its password can do nothing else (RF-A25)', () => {
        it('gets 403 PASSWORD_CHANGE_REQUIRED everywhere except change-password and logout', async () => {
            const u = await mkUser('admin', 'pw1');
            await ds.query(`UPDATE users SET requires_pwd_change = true WHERE user_id = $1`, [u.id]);
            const l = await login(u.username);
            expect(l.body.mustChangePassword).toBe(true);
            const H = { Authorization: `Bearer ${l.body.accessToken}` };

            for (const path of ['/users', '/roles', '/settings', '/service-levels', '/vehicles']) {
                const res = await http().get(api(path)).set(H);
                expect(res.status, path).toBe(403);
                expect(res.body.error).toBe('PASSWORD_CHANGE_REQUIRED');
            }
            expect((await http().post(api('/auth/2fa/enable')).set(H).send({ password: PASSWORD })).status).toBe(403);
        });

        it('can change the password, then log in and use the system normally', async () => {
            const u = await mkUser('admin', 'pw2');
            await ds.query(`UPDATE users SET requires_pwd_change = true WHERE user_id = $1`, [u.id]);
            const token = (await login(u.username)).body.accessToken as string;
            await new Promise((r) => setTimeout(r, 1100));

            await http().patch(api('/auth/change-password')).set({ Authorization: `Bearer ${token}` }).send({ currentPassword: PASSWORD, newPassword: 'ChangedNow1234!' }).expect(204);

            const again = await login(u.username, 'ChangedNow1234!');
            expect(again.body.mustChangePassword).toBe(false);
            expect((await http().get(api('/roles')).set({ Authorization: `Bearer ${again.body.accessToken}` })).status).toBe(200);
        });

        it('can log out', async () => {
            const u = await mkUser('coordinator', 'pw3');
            await ds.query(`UPDATE users SET requires_pwd_change = true WHERE user_id = $1`, [u.id]);
            const token = (await login(u.username)).body.accessToken as string;
            expect((await http().post(api('/auth/logout')).set({ Authorization: `Bearer ${token}` })).status).toBe(204);
        });

        it('an expired password (older than password_expiration_days) is enforced the same way', async () => {
            const u = await mkUser('coordinator', 'pw4');
            await ds.query(`UPDATE users SET password_changed_at = now() - interval '200 days' WHERE user_id = $1`, [u.id]);
            const token = (await login(u.username)).body.accessToken as string;
            const res = await http().get(api('/roles')).set({ Authorization: `Bearer ${token}` });
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('PASSWORD_CHANGE_REQUIRED');
        });
    });

    // ── login does not reveal which accounts exist ─────────────────────────────
    describe('login answers do not reveal accounts', () => {
        it('a locked account with a WRONG password gets the generic answer, and no extra attempt is counted', async () => {
            const u = await mkUser('coordinator', 'en1');
            for (let i = 0; i < 5; i++) await login(u.username, 'Wrong-Passw0rd!');
            const before = (await userRow(u.id)).failed_attempts;

            const wrong = await login(u.username, 'Another-Wrong1!');
            expect(wrong.status).toBe(401);
            expect(wrong.body.error).toBe('INVALID_CREDENTIALS');
            expect((await userRow(u.id)).failed_attempts).toBe(before);

            const right = await login(u.username);
            expect(right.body.error).toBe('ACCOUNT_LOCKED'); // the real owner still learns why
        });
    });

    // ── nobody locks themselves out ────────────────────────────────────────────
    describe('own account', () => {
        it('cannot be deleted, deactivated or re-roled by its owner; other edits are fine', async () => {
            const u = await mkUser('admin', 'self1');
            const H = { Authorization: `Bearer ${(await login(u.username)).body.accessToken}` };

            for (const res of [
                await http().delete(api(`/users/${u.id}`)).set(H),
                await http().put(api(`/users/${u.id}`)).set(H).send({ active: false }),
                await http().patch(api(`/users/${u.id}/role`)).set(H).send({ roleId: roles.supervisor }),
            ]) {
                expect(res.status).toBe(403);
                expect(res.body.error).toBe('CANNOT_MODIFY_OWN_ACCOUNT');
            }
            const row = await userRow(u.id);
            expect([row.active, row.deleted_at, row.role_id]).toEqual([true, null, roles.admin]);

            expect((await http().put(api(`/users/${u.id}`)).set(H).send({ fullName: 'Renamed Myself' })).status).toBe(200);
        });

        it('root cannot delete itself either', async () => {
            const [{ user_id }] = await ds.query(`SELECT user_id FROM users WHERE username = $1`, [`hd_base_root_${run}`]);
            expect((await http().delete(api(`/users/${user_id}`)).set(auth('root'))).status).toBe(403);
        });
    });

    // ── 2FA needs the password ─────────────────────────────────────────────────
    describe('2FA enrolment asks for the password', () => {
        it('wrong or missing password → 401 / 400, and the account is not touched', async () => {
            const u = await mkUser('coordinator', 'tfp');
            const H = { Authorization: `Bearer ${(await login(u.username)).body.accessToken}` };

            const wrong = await http().post(api('/auth/2fa/enable')).set(H).send({ password: 'Wrong-Passw0rd!' });
            expect([wrong.status, wrong.body.error]).toEqual([401, 'INVALID_CREDENTIALS']);
            expect((await http().post(api('/auth/2fa/enable')).set(H).send({})).status).toBe(400);
            expect((await userRow(u.id)).two_factor_secret).toBeNull();
        });
    });

    // ── sync ───────────────────────────────────────────────────────────────────
    describe('sync: a driver only touches their own dispatches', () => {
        let driverA: { id: number; username: string }; let driverB: { id: number; username: string };
        let tokenA: string; let tokenB: string; let dispatchId: number; let reasonId: number;
        let seq = 0;
        const uuid = () => `01933b6e-7f2a-7c3d-9a1b-${(Date.now() % 1e9).toString().padStart(9, '0')}${String(++seq).padStart(3, '0')}`;
        const events = (who: string, list: object[]) => http().post(api('/sync/events')).set({ Authorization: `Bearer ${who}` }).send({ events: list });
        const status = (over: object = {}) => ({ type: 'status_change', clientEventId: uuid(), dispatchId, occurredAt: new Date(Date.now() - 60_000).toISOString(), dispatchStatusId: 2, ...over });
        const evidence = (who: string, fields: Record<string, string>, file?: { buf: Buffer; name: string; type: string }) => {
            let r = http().post(api('/sync/evidences')).set({ Authorization: `Bearer ${who}` });
            for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
            return file ? r.attach('file', file.buf, { filename: file.name, contentType: file.type }) : r;
        };

        beforeAll(async () => {
            driverA = await mkUser('driver', 'drvA'); driverB = await mkUser('driver', 'drvB');
            tokenA = (await login(driverA.username)).body.accessToken; tokenB = (await login(driverB.username)).body.accessToken;
            const [{ route_batch_id }] = await ds.query(`INSERT INTO route_batches (driver_id, shift_date) VALUES ($1, current_date) RETURNING route_batch_id`, [driverA.id]);
            const [{ dispatch_id }] = await ds.query(
                `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, source_order_ref, delivery_address) VALUES (1, 1, $1, $2, 'Av. Test 1') RETURNING dispatch_id`,
                [route_batch_id, `hd-${run}-1`],
            );
            dispatchId = dispatch_id;
            reasonId = (await ds.query(`SELECT incident_reason_id FROM incident_reasons ORDER BY 1 LIMIT 1`))[0].incident_reason_id;
        });

        it('the assigned driver syncs status changes and incidents (201, applied)', async () => {
            const res = await events(tokenA, [status(), { type: 'incident', clientEventId: uuid(), dispatchId, occurredAt: new Date(Date.now() - 30_000).toISOString(), incidentReasonId: reasonId, detail: 'Client absent' }]);
            expect(res.status).toBe(201);
            expect(res.body.results.map((r: any) => r.outcome)).toEqual(['applied', 'applied']);
            expect((await ds.query(`SELECT dispatch_status_id FROM dispatches WHERE dispatch_id = $1`, [dispatchId]))[0].dispatch_status_id).toBe(2);
        });

        it('another driver cannot: failed "Dispatch not found." and the dispatch is untouched', async () => {
            await ds.query(`UPDATE dispatches SET dispatch_status_id = 1 WHERE dispatch_id = $1`, [dispatchId]);
            const res = await events(tokenB, [status({ dispatchStatusId: 3 })]);

            expect(res.status).toBe(201);
            expect(res.body.results[0]).toMatchObject({ outcome: 'failed', error: 'Dispatch not found.' });
            expect((await ds.query(`SELECT dispatch_status_id FROM dispatches WHERE dispatch_id = $1`, [dispatchId]))[0].dispatch_status_id).toBe(1);
            expect(res.body.results[0].error).toBe((await events(tokenB, [status({ dispatchId: 99999999 })])).body.results[0].error);
        });

        it('a retry of an applied event is already_processed, not a second write', async () => {
            const ev = status();
            expect((await events(tokenA, [ev])).body.results[0].outcome).toBe('applied');
            expect((await events(tokenA, [ev])).body.results[0].outcome).toBe('already_processed');
        });

        it('a status or incident reason that does not exist is failed with a clear message', async () => {
            const res = await events(tokenA, [status({ dispatchStatusId: 999999 }), { type: 'incident', clientEventId: uuid(), dispatchId, occurredAt: new Date(Date.now() - 30_000).toISOString(), incidentReasonId: 999999 }]);
            expect(res.body.results.map((r: any) => r.error)).toEqual(['The given dispatch status does not exist.', 'The given incident reason does not exist.']);
        });

        it('ids above INTEGER in an event are a 400 for the batch', async () => {
            expect((await events(tokenA, [status({ dispatchId: 99999999999 })])).status).toBe(400);
        });

        it('a delivered dispatch cannot be reopened by a later (or duplicated) event', async () => {
            const [{ dispatch_id }] = await ds.query(`SELECT dispatch_id FROM dispatches WHERE dispatch_id = $1`, [dispatchId]);
            await ds.query(`UPDATE dispatches SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'delivered') WHERE dispatch_id = $1`, [dispatch_id]);

            const res = await events(tokenA, [status({ dispatchStatusId: 1 })]);

            expect(res.body.results[0]).toMatchObject({ outcome: 'failed', error: 'The dispatch is already delivered: its status cannot change.' });
            expect((await ds.query(`SELECT s.name FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id) WHERE d.dispatch_id = $1`, [dispatch_id]))[0].name).toBe('delivered');
            await ds.query(`UPDATE dispatches SET dispatch_status_id = 1 WHERE dispatch_id = $1`, [dispatch_id]); // reopen for the next tests
        });

        it('an implausible occurredAt (2099, or older than 30 days) is failed', async () => {
            const res = await events(tokenA, [status({ occurredAt: '2099-01-01T00:00:00.000Z' }), status({ occurredAt: '2020-01-01T00:00:00.000Z' })]);
            expect(res.body.results.map((r: any) => r.outcome)).toEqual(['failed', 'failed']);
            expect(res.body.results[0].error).toContain('occurredAt is not plausible');
        });

        it('a non-driver cannot sync', async () => {
            expect((await events(tokens.coordinator, [status()])).status).toBe(403);
        });

        describe('evidences', () => {
            const png = { buf: Buffer.from('89504e470d0a1a0a', 'hex'), name: 'photo.png', type: 'image/png' };

            it('an image is stored with an extension taken from its type; a retry is already_processed', async () => {
                const fields = { clientEventId: uuid(), dispatchId: String(dispatchId), type: 'photo' };
                const res = await evidence(tokenA, fields, png);
                expect(res.status).toBe(201);
                expect(res.body.outcome).toBe('applied');
                const [row] = await ds.query(`SELECT file_url FROM delivery_evidences WHERE delivery_evidence_id = $1`, [fields.clientEventId]);
                expect(row.file_url).toMatch(/\/uploads\/[0-9a-f-]{36}\.png$/);
                expect((await evidence(tokenA, fields, png)).body.outcome).toBe('already_processed');
            });

            it('the extension never comes from the client file name (a.png sent as image/png with a weird name)', async () => {
                const fields = { clientEventId: uuid(), dispatchId: String(dispatchId), type: 'signature' };
                await evidence(tokenA, fields, { ...png, name: 'x.html' });
                const [row] = await ds.query(`SELECT file_url FROM delivery_evidences WHERE delivery_evidence_id = $1`, [fields.clientEventId]);
                expect(row.file_url).toMatch(/\.png$/);
            });

            it('an HTML (or any non-image) file is rejected with 400 and nothing is stored', async () => {
                const id = uuid();
                const res = await evidence(tokenA, { clientEventId: id, dispatchId: String(dispatchId), type: 'photo' }, { buf: Buffer.from('<script>alert(1)</script>'), name: 'x.html', type: 'text/html' });
                expect(res.status).toBe(400);
                expect((await ds.query(`SELECT 1 FROM delivery_evidences WHERE delivery_evidence_id = $1`, [id])).length).toBe(0);
            });

            it('a file over 10 MB is rejected (413) instead of being buffered in memory', async () => {
                const res = await evidence(tokenA, { clientEventId: uuid(), dispatchId: String(dispatchId), type: 'photo' }, { buf: Buffer.alloc(11 * 1024 * 1024, 1), name: 'big.png', type: 'image/png' });
                expect(res.status).toBe(413);
            });

            it('a photo/signature without its file, or an otp without its code, is failed', async () => {
                const noFile = await evidence(tokenA, { clientEventId: uuid(), dispatchId: String(dispatchId), type: 'photo' });
                expect(noFile.body).toMatchObject({ outcome: 'failed', error: 'A photo or signature evidence needs its file.' });
                const noCode = await evidence(tokenA, { clientEventId: uuid(), dispatchId: String(dispatchId), type: 'otp' });
                expect(noCode.body).toMatchObject({ outcome: 'failed', error: 'An otp evidence needs its otpCode.' });
                const otp = await evidence(tokenA, { clientEventId: uuid(), dispatchId: String(dispatchId), type: 'otp', otpCode: '123456' });
                expect(otp.body.outcome).toBe('applied');
            });

            it('another driver\'s dispatch: failed, and nothing is uploaded or stored', async () => {
                const id = uuid();
                const res = await evidence(tokenB, { clientEventId: id, dispatchId: String(dispatchId), type: 'photo' }, png);
                expect(res.body).toMatchObject({ outcome: 'failed', error: 'Dispatch not found.' });
                expect((await ds.query(`SELECT 1 FROM delivery_evidences WHERE delivery_evidence_id = $1`, [id])).length).toBe(0);
            });
        });
    });
});
