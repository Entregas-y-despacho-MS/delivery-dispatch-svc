// ST-14.3 — Pruebas de integración e2e sobre endpoints protegidos (401 y 403).
//
// Cubre el mecanismo de los 2 guards globales (JwtAuthGuard, RolesGuard), no cada endpoint uno
// por uno: sin token, token malformado, rol insuficiente en un endpoint @AdminOnly(), rol
// suficiente, root bypaseando @AdminOnly(), y un endpoint sin @Roles() (cualquier autenticado).
// Necesita una base de datos real y alcanzable (misma config que usa la app vía .env) — los
// usuarios de prueba se crean y se borran en cada corrida, no dependen de la semilla.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { User } from '../src/modules/auth/users/entities/user.entity.js';
import { Role } from '../src/modules/auth/roles/entities/role.entity.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';

describe('Endpoints protegidos — 401/403 (e2e)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const createdUserIds: number[] = [];

    let adminToken: string;
    let driverToken: string;
    let rootToken: string;

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleRef.createNestApplication();

        // Mismo bootstrap que main.ts — el shape de error ({statusCode, error, message, ...})
        // y el prefijo de rutas dependen de esto.
        const cfg = app.get(AppConfig);
        apiPrefix = cfg.apiPrefix;
        app.setGlobalPrefix(apiPrefix);
        app.useGlobalPipes(new ValidationPipe({
            transform:            true,
            whitelist:            true,
            forbidNonWhitelisted: true,
            transformOptions:     { enableImplicitConversion: false },
        }));
        app.useGlobalFilters(new HttpExceptionFilter());

        await app.init();

        dataSource = moduleRef.get(DataSource);
        const userRepo = dataSource.getRepository(User);
        const roleRepo = dataSource.getRepository(Role);

        const adminRole  = await roleRepo.findOneByOrFail({ name: 'admin' });
        const driverRole = await roleRepo.findOneByOrFail({ name: 'driver' });
        const rootRole   = await roleRepo.findOneByOrFail({ name: 'root' });

        const password     = 'E2eTest1234';
        const passwordHash = await hashPassword(password);
        const suffix       = Date.now();

        const [testAdmin, testDriver, testRoot] = await userRepo.save([
            userRepo.create({ fullName: 'E2E Admin',  username: `e2e_admin_${suffix}`,  passwordHash, roleId: adminRole.id,  active: true, requiresPwdChange: false }),
            userRepo.create({ fullName: 'E2E Driver', username: `e2e_driver_${suffix}`, passwordHash, roleId: driverRole.id, active: true, requiresPwdChange: false }),
            userRepo.create({ fullName: 'E2E Root',   username: `e2e_root_${suffix}`,   passwordHash, roleId: rootRole.id,   active: true, requiresPwdChange: false }),
        ]);
        createdUserIds.push(testAdmin.id, testDriver.id, testRoot.id);

        const login = async (username: string): Promise<string> => {
            const res = await request(app.getHttpServer())
                .post(`/${apiPrefix}/auth/login`)
                .send({ username, password });
            return res.body.accessToken as string;
        };

        adminToken  = await login(testAdmin.username);
        driverToken = await login(testDriver.username);
        rootToken   = await login(testRoot.username);
    });

    afterAll(async () => {
        if (createdUserIds.length > 0) {
            await dataSource.getRepository(User).delete(createdUserIds);
        }
        await app.close();
    });

    describe('sin token válido', () => {
        it('sin header Authorization → 401 INVALID_TOKEN', async () => {
            const res = await request(app.getHttpServer()).get(`/${apiPrefix}/settings`);
            expect(res.status).toBe(401);
            expect(res.body.error).toBe('INVALID_TOKEN');
        });

        it('token malformado → 401 INVALID_TOKEN', async () => {
            const res = await request(app.getHttpServer())
                .get(`/${apiPrefix}/settings`)
                .set('Authorization', 'Bearer esto-no-es-un-jwt-valido');
            expect(res.status).toBe(401);
            expect(res.body.error).toBe('INVALID_TOKEN');
        });
    });

    describe('token válido, rol insuficiente', () => {
        it('driver contra un endpoint @AdminOnly() → 403 INSUFFICIENT_PERMISSIONS', async () => {
            const res = await request(app.getHttpServer())
                .get(`/${apiPrefix}/settings`)
                .set('Authorization', `Bearer ${driverToken}`);
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('INSUFFICIENT_PERMISSIONS');
        });
    });

    describe('token válido, rol suficiente', () => {
        it('admin contra un endpoint @AdminOnly() → 200', async () => {
            const res = await request(app.getHttpServer())
                .get(`/${apiPrefix}/settings`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(res.status).toBe(200);
        });

        it('root bypasea @AdminOnly() aunque su rol no sea admin → 200', async () => {
            const res = await request(app.getHttpServer())
                .get(`/${apiPrefix}/settings`)
                .set('Authorization', `Bearer ${rootToken}`);
            expect(res.status).toBe(200);
        });
    });

    describe('endpoint sin @Roles() — cualquier autenticado', () => {
        it('un driver puede desloguearse aunque no sea admin → 204', async () => {
            const res = await request(app.getHttpServer())
                .post(`/${apiPrefix}/auth/logout`)
                .set('Authorization', `Bearer ${driverToken}`);
            expect(res.status).toBe(204);
        });
    });
});
