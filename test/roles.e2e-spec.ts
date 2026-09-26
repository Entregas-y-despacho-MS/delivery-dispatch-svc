// Roles listing (read-only catalog): filters, sorting, pagination, user counts and permissions,
// against a real database. Self-cleaning (unique run tag); counts are asserted as deltas, so it is safe
// to run against a database that already has users.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';

const NAMES = ['root', 'admin', 'coordinator', 'supervisor', 'driver'];

describe('Roles (e2e)', () => {
    let app: INestApplication;
    let ds: DataSource;
    let prefix: string;
    const tokens: Record<string, string> = {};
    const roleId: Record<string, number> = {};
    const run = Date.now().toString(36);

    const api = (p = '') => `/${prefix}/roles${p}`;
    const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
    const list = (qs = '', who = 'admin') => request(app.getHttpServer()).get(api(qs ? `?${qs}` : '')).set(auth(who));
    const names = (res: request.Response) => res.body.data.map((r: any) => r.name);
    const counts = async (name: string) => (await list(`name=${name}`)).body.data[0] as { userCount: number; activeUserCount: number };
    const mkUser = (role: string, tag: string, opts: { active?: boolean; deleted?: boolean } = {}) => ds.query(
        `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change, active, deleted_at) VALUES ($1,$2,$3,$4,false,$5,$6) RETURNING user_id`,
        [roleId[role], `RL ${tag}`, `rl_${tag}_${run}`, 'x', opts.active ?? true, opts.deleted ? new Date() : null],
    );

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        prefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(prefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        ds = moduleRef.get(DataSource);
        for (const r of await ds.query(`SELECT role_id, name FROM roles`)) roleId[r.name] = r.role_id;
        const hash = await hashPassword('E2eTest1234');
        for (const role of NAMES) {
            await ds.query(`INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1,$2,$3,$4,false)`, [roleId[role], `RL ${role}`, `rl_base_${role}_${run}`, hash]);
            tokens[role] = (await request(app.getHttpServer()).post(`/${prefix}/auth/login`).send({ username: `rl_base_${role}_${run}`, password: 'E2eTest1234' })).body.accessToken;
        }
    });

    afterAll(async () => {
        await ds.query(`DELETE FROM users WHERE username LIKE $1`, [`rl\\_%\\_${run}`]);
        await app.close();
    });

    describe('permissions', () => {
        it('no token → 401', async () => {
            expect((await request(app.getHttpServer()).get(api())).status).toBe(401);
            expect((await request(app.getHttpServer()).get(api('/1'))).status).toBe(401);
        });

        it('admin, coordinator and root can list and read; supervisor and driver cannot (403)', async () => {
            for (const who of ['admin', 'coordinator', 'root']) {
                expect((await list('', who)).status, who).toBe(200);
                expect((await request(app.getHttpServer()).get(api(`/${roleId.driver}`)).set(auth(who))).status, who).toBe(200);
            }
            for (const who of ['supervisor', 'driver']) {
                expect((await list('', who)).status, who).toBe(403);
                expect((await request(app.getHttpServer()).get(api(`/${roleId.driver}`)).set(auth(who))).status, who).toBe(403);
            }
        });

        it('the catalog is read-only: there is no way to create, edit or delete a role', async () => {
            const http = request(app.getHttpServer());
            expect((await http.post(api()).set(auth('root')).send({ name: 'hacker' })).status).toBe(404);
            expect((await request(app.getHttpServer()).put(api(`/${roleId.driver}`)).set(auth('root')).send({ name: 'x' })).status).toBe(404);
            expect((await request(app.getHttpServer()).delete(api(`/${roleId.driver}`)).set(auth('root'))).status).toBe(404);
        });
    });

    describe('listing', () => {
        it('returns the 5 roles ordered by id, with the pagination meta', async () => {
            const res = await list();

            expect(res.status).toBe(200);
            expect(names(res)).toEqual(NAMES);
            expect(res.body.meta).toEqual({ page: 1, limit: 10, total: 5, pages: 1 });
            const ids: number[] = res.body.data.map((r: any) => r.id);
            expect(ids).toEqual([...ids].sort((a, b) => a - b));
        });

        it('every role has exactly id, name, createdAt, userCount and activeUserCount', async () => {
            for (const role of (await list()).body.data) {
                expect(Object.keys(role).sort()).toEqual(['activeUserCount', 'createdAt', 'id', 'name', 'userCount']);
                expect(Number.isInteger(role.userCount) && Number.isInteger(role.activeUserCount)).toBe(true);
                expect(role.activeUserCount).toBeLessThanOrEqual(role.userCount);
                expect(role.id).toBe(roleId[role.name]);
            }
        });

        it('pagination walks the catalog without repeating or skipping a role', async () => {
            const seen: string[] = [];
            for (const page of [1, 2, 3]) {
                const res = await list(`limit=2&page=${page}`);
                expect(res.body.meta).toMatchObject({ page, limit: 2, total: 5, pages: 3 });
                seen.push(...names(res));
            }
            expect(seen).toEqual(NAMES);
            expect((await list('limit=2&page=4')).body.data).toEqual([]);
        });
    });

    describe('user counts', () => {
        it('count the users of each role, excluding deleted ones; active ones are counted apart', async () => {
            const before = await counts('supervisor');
            await mkUser('supervisor', 'c1');
            await mkUser('supervisor', 'c2');
            await mkUser('supervisor', 'c3', { active: false });
            await mkUser('supervisor', 'c4', { deleted: true });

            const after = await counts('supervisor');

            expect(after.userCount - before.userCount).toBe(3);        // 2 active + 1 inactive; the deleted one is not counted
            expect(after.activeUserCount - before.activeUserCount).toBe(2);
        });

        it('other roles are not affected, and the same counts come from GET /roles/:id', async () => {
            const driverBefore = await counts('driver');
            await mkUser('supervisor', 'c5');

            expect(await counts('driver')).toEqual(driverBefore);
            const one = (await request(app.getHttpServer()).get(api(`/${roleId.supervisor}`)).set(auth('admin'))).body;
            const fromList = await counts('supervisor');
            expect([one.userCount, one.activeUserCount]).toEqual([fromList.userCount, fromList.activeUserCount]);
            expect(one).toMatchObject({ id: roleId.supervisor, name: 'supervisor' });
        });

        it('a role nobody has is 0 / 0 (not missing)', async () => {
            await ds.query(`INSERT INTO roles (name) VALUES ('rl_empty_${run}') ON CONFLICT DO NOTHING`);
            try {
                const res = await list(`search=rl_empty_${run}`);
                expect(res.body.data).toHaveLength(1);
                expect([res.body.data[0].userCount, res.body.data[0].activeUserCount]).toEqual([0, 0]);
            } finally {
                await ds.query(`DELETE FROM roles WHERE name = $1`, [`rl_empty_${run}`]);
            }
        });
    });

    describe('filters', () => {
        it('name → exactly that role', async () => {
            for (const name of NAMES) expect(names(await list(`name=${name}`))).toEqual([name]);
        });

        it('search → name contains, case-insensitive; no match → empty page with total 0', async () => {
            expect(names(await list('search=DRIV'))).toEqual(['driver']);
            expect(names(await list('search=or'))).toEqual(['coordinator', 'supervisor', 'driver'].filter((n) => n.includes('or')));
            const none = await list('search=zzz-nothing');
            expect(none.body).toMatchObject({ data: [], meta: { total: 0, pages: 0 } });
        });

        it('% and _ in search are text, not wildcards', async () => {
            expect((await list('search=%')).body.data).toEqual([]);
            expect((await list('search=_')).body.data).toEqual([]);
            expect((await list('search=dr_ver')).body.data).toEqual([]);
        });

        it('search and name together must BOTH hold', async () => {
            expect(names(await list('search=dri&name=driver'))).toEqual(['driver']);
            expect((await list('search=admin&name=driver')).body.data).toEqual([]);
        });

        it('assignable=true as admin (or coordinator) leaves root out; as root it returns all five', async () => {
            expect(names(await list('assignable=true', 'admin'))).toEqual(NAMES.filter((n) => n !== 'root'));
            expect(names(await list('assignable=true', 'coordinator'))).toEqual(NAMES.filter((n) => n !== 'root'));
            expect(names(await list('assignable=true', 'root'))).toEqual(NAMES);
        });

        it('assignable=true combines with the other filters; asking an admin for root finds nothing', async () => {
            expect((await list('assignable=true&name=root', 'admin')).body.data).toEqual([]);
            expect(names(await list('assignable=true&name=root', 'root'))).toEqual(['root']);
            expect(names(await list('assignable=true&search=r', 'admin'))).toEqual(NAMES.filter((n) => n !== 'root' && n.includes('r')));
        });

        it('assignable=false or empty (a "todos" selector) is no filter, not an error', async () => {
            expect(names(await list('assignable=false', 'admin'))).toEqual(NAMES);
            const empty = await list('assignable=', 'admin');
            expect([empty.status, names(empty)]).toEqual([200, NAMES]);
        });

        it('every role that assignable=true offers can really be given to a user by that admin', async () => {
            for (const role of (await list('assignable=true', 'admin')).body.data) {
                const res = await request(app.getHttpServer()).post(`/${prefix}/users`).set(auth('admin'))
                    .send({ fullName: 'Assignable', username: `rl_asg_${role.name}_${run}`, password: 'Passw0rd!', roleId: role.id });
                expect(res.status, role.name).toBe(201);
            }
            // …and the one it hides is really refused
            const root = await request(app.getHttpServer()).post(`/${prefix}/users`).set(auth('admin'))
                .send({ fullName: 'Assignable', username: `rl_asg_root_${run}`, password: 'Passw0rd!', roleId: roleId.root });
            expect(root.status).toBe(403);
        });
    });

    describe('sorting', () => {
        it('sortBy=name asc / desc', async () => {
            expect(names(await list('sortBy=name'))).toEqual([...NAMES].sort());
            expect(names(await list('sortBy=name&sortOrder=desc'))).toEqual([...NAMES].sort().reverse());
        });

        it('default and sortOrder=desc on id', async () => {
            expect(names(await list('sortOrder=desc'))).toEqual([...NAMES].reverse());
            expect(names(await list('sortBy=id&sortOrder=ASC'))).toEqual(NAMES);
        });

        it('sortBy=createdAt is stable: roles created together are ordered by id', async () => {
            const res = await list('sortBy=createdAt');
            const ids = res.body.data.map((r: any) => r.id);
            const dates = res.body.data.map((r: any) => new Date(r.createdAt).getTime());
            expect(dates).toEqual([...dates].sort((a, b) => a - b));
            ids.forEach((id: number, i: number) => { if (i && dates[i] === dates[i - 1]) expect(id).toBeGreaterThan(ids[i - 1]); });
        });

        it('sorting applies across pages', async () => {
            const first = names(await list('sortBy=name&sortOrder=desc&limit=2&page=1'));
            const second = names(await list('sortBy=name&sortOrder=desc&limit=2&page=2'));
            expect([...first, ...second]).toEqual([...NAMES].sort().reverse().slice(0, 4));
        });
    });

    describe('invalid input → 400 (never a 500)', () => {
        it.each([
            'name=Admin', 'name=superuser', 'name=', 'sortBy=userCount', 'sortBy=password', 'sortOrder=up', 'assignable=maybe', 'assignable=1',
            'limit=101', 'limit=0', 'page=0', 'page=1000001', 'page=1e18', 'foo=bar', `search=${'a'.repeat(101)}`, 'search=%00', 'name=admin&name=driver',
        ])('?%s', async (qs) => {
            const res = await list(qs);
            expect(res.status, qs).toBe(400);
        });

        it('a role id that is not a number, is 0, or is above INTEGER → 400; one that does not exist → 404 ROLE_NOT_FOUND', async () => {
            for (const id of ['abc', '0', '-1', '1.5', '99999999999']) {
                expect((await request(app.getHttpServer()).get(api(`/${id}`)).set(auth('admin'))).status, id).toBe(400);
            }
            const missing = await request(app.getHttpServer()).get(api('/99999999')).set(auth('admin'));
            expect([missing.status, missing.body.error]).toEqual([404, 'ROLE_NOT_FOUND']);
        });
    });
});
