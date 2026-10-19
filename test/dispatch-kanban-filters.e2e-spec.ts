import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';

describe('GET /dispatches/kanban/filters (e2e)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const run = Date.now().toString(36);
    const tag = `e2e_kf_${run}`;
    const tokens: Record<string, string> = {};
    const usernames: string[] = [];

    const url = () => `/${apiPrefix}/dispatches/kanban/filters`;
    const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        apiPrefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(apiPrefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        dataSource = moduleRef.get(DataSource);

        const passwordHash = await hashPassword('E2eTest1234');
        for (const role of ['coordinator', 'supervisor', 'driver', 'admin', 'root']) {
            const username = `${tag}_${role}`;
            usernames.push(username);
            await dataSource.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change, active)
                 VALUES ((SELECT role_id FROM roles WHERE name = $1), $2, $3, $4, FALSE, TRUE)`,
                [role, `Kanban filter ${role} ${run}`, username, passwordHash],
            );
            const login = await request(app.getHttpServer()).post(`/${apiPrefix}/auth/login`).send({ username, password: 'E2eTest1234' });
            tokens[role] = login.body.accessToken as string;
        }

        const driverRole = (await dataSource.query(`SELECT role_id FROM roles WHERE name = 'driver'`))[0].role_id;
        await dataSource.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, active, requires_pwd_change)
             VALUES ($1, 'Kanban inactive driver', $2, $3, FALSE, FALSE)`,
            [driverRole, `${tag}_inactive`, passwordHash],
        );
        usernames.push(`${tag}_inactive`);
        await dataSource.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, deleted_at, requires_pwd_change)
             VALUES ($1, 'Kanban deleted driver', $2, $3, NOW(), FALSE)`,
            [driverRole, `${tag}_deleted`, passwordHash],
        );
        usernames.push(`${tag}_deleted`);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized && usernames.length) {
            await dataSource.query(`DELETE FROM users WHERE username = ANY($1::text[])`, [usernames]);
        }
        await app?.close();
    });

    it('requires authentication', async () => {
        expect((await request(app.getHttpServer()).get(url())).status).toBe(401);
    });

    it('allows coordinators, supervisors and root, and returns only the filter fields', async () => {
        for (const role of ['coordinator', 'supervisor', 'root']) {
            const response = await request(app.getHttpServer()).get(url()).set(auth(role));
            expect(response.status, role).toBe(200);
            expect(response.body).toHaveProperty('drivers');
            expect(response.body).toHaveProperty('dispatchTypes');
            expect(response.body.drivers).toContainEqual(expect.objectContaining({ fullName: `Kanban filter driver ${run}` }));
            expect(response.body.drivers).not.toContainEqual(expect.objectContaining({ fullName: 'Kanban inactive driver' }));
            expect(response.body.drivers).not.toContainEqual(expect.objectContaining({ fullName: 'Kanban deleted driver' }));
            expect(response.body.drivers.every((driver: object) => Object.keys(driver).sort().join(',') === 'fullName,id')).toBe(true);
            expect(response.body.dispatchTypes.length).toBeGreaterThan(0);
            expect(response.body.dispatchTypes.every((type: object) => Object.keys(type).sort().join(',') === 'id,name')).toBe(true);
        }
    });

    it('denies drivers and admins', async () => {
        for (const role of ['driver', 'admin']) {
            expect((await request(app.getHttpServer()).get(url()).set(auth(role))).status, role).toBe(403);
        }
    });
});
