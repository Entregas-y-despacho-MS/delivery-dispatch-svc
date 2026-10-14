// ST-50.3 — Manual trigger of the scheduled tasks (POST /planning/generate and /planning/cutoff).
//
// Boots the real AppModule against a real database (same config the app reads from .env). The
// users it creates are removed in afterAll. The scheduler tick is off in e2e (SCHEDULER_ENABLED=false
// in vitest.config.e2e.ts), so nothing here runs on its own; the tasks are test doubles registered
// in the live registry.
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
import { ScheduledTaskRegistry } from '../src/app/scheduler/services/scheduled-task-registry.service.js';
import { PLAN_GENERATION_TASK, ROUTE_CUTOFF_TASK } from '../src/app/scheduler/scheduled-task-names.js';
import { SCHEDULED_TASK_RUN_ACTION } from '../src/app/scheduler/adapters/audit-log-task-run-log.adapter.js';
import { PlanGenerationService } from '../src/app/planning/services/plan-generation.service.js';

describe('Manual trigger of scheduled tasks (e2e)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const createdUserIds: number[] = [];
    const startedAt = new Date();

    let coordinatorToken: string;
    let adminToken: string;
    let driverToken: string;
    let rootToken: string;

    let generatorRuns = 0;
    let releaseGenerator: () => void = () => {};
    let generatorBehaviour: 'fast' | 'blocked' | 'failing' = 'fast';

    const post = (path: string, token?: string) => {
        const req = request(app.getHttpServer()).post(`/${apiPrefix}${path}`);
        return token ? req.set('Authorization', `Bearer ${token}`) : req;
    };

    beforeAll(async () => {
        // The generator is registered by the real PlanningModule; only its service is replaced by a double
        // (the real run is test/plan-generation.e2e-spec.ts).
        const generatorDouble = {
            run: async () => {
                generatorRuns++;
                if (generatorBehaviour === 'blocked') {
                    await new Promise<void>((resolve) => (releaseGenerator = resolve));
                }
                if (generatorBehaviour === 'failing') throw new Error('OSRM unavailable');
                return { status: 'executed' };
            },
        };
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(PlanGenerationService).useValue(generatorDouble)
            .compile();
        app = moduleRef.createNestApplication();

        // Same bootstrap as main.ts.
        const cfg = app.get(AppConfig);
        apiPrefix = cfg.apiPrefix;
        app.setGlobalPrefix(apiPrefix);
        app.useGlobalPipes(new ValidationPipe({
            transform: true,
            whitelist: true,
            forbidNonWhitelisted: true,
            transformOptions: { enableImplicitConversion: false },
        }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();

        dataSource = moduleRef.get(DataSource);
        const userRepo = dataSource.getRepository(User);
        const roleRepo = dataSource.getRepository(Role);
        const password = 'E2eTest1234';
        const passwordHash = await hashPassword(password);
        const suffix = Date.now();

        const roles = ['coordinator', 'admin', 'driver', 'root'] as const;
        const users = await userRepo.save(
            await Promise.all(
                roles.map(async (name) => {
                    const role = await roleRepo.findOneByOrFail({ name });
                    return userRepo.create({
                        fullName: `E2E ${name}`,
                        username: `e2e_sched_${name}_${suffix}`,
                        passwordHash,
                        roleId: role.id,
                        active: true,
                        requiresPwdChange: false,
                    });
                }),
            ),
        );
        createdUserIds.push(...users.map((user) => user.id));

        const tokens: string[] = [];
        for (const user of users) {
            const res = await request(app.getHttpServer())
                .post(`/${apiPrefix}/auth/login`)
                .send({ username: user.username, password });
            tokens.push(res.body.accessToken as string);
        }
        [coordinatorToken, adminToken, driverToken, rootToken] = tokens;
    });

    afterAll(async () => {
        await dataSource.query(
            `DELETE FROM audit_logs WHERE action = $1 AND created_at >= $2 AND detail LIKE '%"trigger":"manual"%'`,
            [SCHEDULED_TASK_RUN_ACTION, startedAt],
        );
        if (createdUserIds.length) {
            await dataSource.query('DELETE FROM users WHERE user_id = ANY($1::int[])', [createdUserIds]);
        }
        await app?.close();
    });

    describe('guards', () => {
        it.each(['/planning/generate', '/planning/cutoff'])('%s without a token is 401', async (path) => {
            const res = await post(path);
            expect(res.status).toBe(401);
        });

        it.each([
            ['driver', () => driverToken],
            ['admin', () => adminToken],
        ])('%s is 403 on both endpoints', async (_role, token) => {
            for (const path of ['/planning/generate', '/planning/cutoff']) {
                const res = await post(path, token());
                expect(res.status).toBe(403);
                expect(res.body.error).toBe('INSUFFICIENT_PERMISSIONS');
            }
        });
    });

    describe('task not registered yet', () => {
        it('answers 503 SCHEDULED_TASK_NOT_AVAILABLE for the cutoff, which has no owner yet', async () => {
            const res = await post('/planning/cutoff', coordinatorToken);

            expect(res.status).toBe(503);
            expect(res.body.error).toBe('SCHEDULED_TASK_NOT_AVAILABLE');
        });

        it('the generator is registered by the planning module on plan_generation_times', () => {
            const task = app.get(ScheduledTaskRegistry).get(PLAN_GENERATION_TASK);

            expect(task).toBeDefined();
            expect(task!.schedule).toEqual({ kind: 'times', settingKey: 'plan_generation_times' });
        });
    });

    describe('task registered', () => {
        let cutoffRuns = 0;

        beforeAll(() => {
            const registry = app.get(ScheduledTaskRegistry);
            registry.register({
                name: ROUTE_CUTOFF_TASK,
                schedule: { kind: 'time', settingKey: 'route_cutoff_time' },
                run: async () => {
                    cutoffRuns++;
                },
            });
        });

        it('a coordinator runs the generator and gets the result', async () => {
            const before = generatorRuns;

            const res = await post('/planning/generate', coordinatorToken);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ task: PLAN_GENERATION_TASK, status: 'executed' });
            expect(Number.isNaN(Date.parse(res.body.finishedAt))).toBe(false);
            expect(generatorRuns).toBe(before + 1);
        });

        it('a coordinator runs the cutoff', async () => {
            const before = cutoffRuns;

            const res = await post('/planning/cutoff', coordinatorToken);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ task: ROUTE_CUTOFF_TASK, status: 'executed' });
            expect(cutoffRuns).toBe(before + 1);
        });

        it('root passes the role check', async () => {
            const res = await post('/planning/generate', rootToken);
            expect(res.status).toBe(200);
        });

        it('leaves a trace of the manual run in the audit log', async () => {
            await post('/planning/generate', coordinatorToken);

            const rows: { detail: string }[] = await dataSource.query(
                `SELECT detail FROM audit_logs WHERE action = $1 AND created_at >= $2 AND detail LIKE $3`,
                [SCHEDULED_TASK_RUN_ACTION, startedAt, `%"task":"${PLAN_GENERATION_TASK}"%`],
            );
            expect(rows.length).toBeGreaterThan(0);
            expect(JSON.parse(rows[0].detail)).toMatchObject({ trigger: 'manual', occurrence: null });
        });

        it('answers 409 and does not start a second run while the task is running', async () => {
            generatorBehaviour = 'blocked';
            const before = generatorRuns;
            const first = post('/planning/generate', coordinatorToken).then((res) => res);
            await new Promise((resolve) => setTimeout(resolve, 300));

            const second = await post('/planning/generate', coordinatorToken);

            expect(second.status).toBe(409);
            expect(second.body.error).toBe('SCHEDULED_TASK_ALREADY_RUNNING');
            expect(generatorRuns).toBe(before + 1);

            releaseGenerator();
            expect((await first).status).toBe(200);
            generatorBehaviour = 'fast';
        });

        it('a different task is not blocked by the running one', async () => {
            generatorBehaviour = 'blocked';
            const first = post('/planning/generate', coordinatorToken).then((res) => res);
            await new Promise((resolve) => setTimeout(resolve, 300));

            const cutoff = await post('/planning/cutoff', coordinatorToken);

            expect(cutoff.status).toBe(200);
            releaseGenerator();
            await first;
            generatorBehaviour = 'fast';
        });

        it('answers 500 SCHEDULED_TASK_FAILED when the task throws, and the lock is free afterwards', async () => {
            generatorBehaviour = 'failing';
            const failed = await post('/planning/generate', coordinatorToken);
            generatorBehaviour = 'fast';
            const retried = await post('/planning/generate', coordinatorToken);

            expect(failed.status).toBe(500);
            expect(failed.body.error).toBe('SCHEDULED_TASK_FAILED');
            expect(JSON.stringify(failed.body)).not.toContain('OSRM');
            expect(retried.status).toBe(200);
        });
    });
});
