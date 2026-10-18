// ST-224.1 — Temporary block of a client IP on the public tracking page (Scenario 5), end to end.
//
// The limit is read when the controller class is defined, so this file sets a small one BEFORE the app is
// imported; vitest gives each file its own module registry, so the other suites keep the default. Every request
// of supertest comes from the same IP, which is exactly the case the limit is for.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { TrackedFixtures } from './helpers/tracked-dispatch.fixtures.js';

const LIMIT = 5;
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

describe('Public tracking IP block (e2e, ST-224.1)', () => {
    let app: INestApplication;
    let db: DataSource;
    let fixtures: TrackedFixtures;
    let prefix: string;

    const run = Date.now().toString(36).toUpperCase();
    const http = () => request(app.getHttpServer());
    const view = (token: string) => http().get(`/${prefix}/public/tracking/${token}`);

    beforeAll(async () => {
        process.env.THROTTLE_PUBLIC_TRACKING_LIMIT = String(LIMIT);
        process.env.THROTTLE_TTL_MS = '60000';
        const { Test } = await import('@nestjs/testing');
        const { AppModule } = await import('../src/app.module.js');
        const { AppConfig } = await import('../src/config/services/app.config.js');
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        prefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(prefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        db = moduleRef.get(DataSource);
        fixtures = new TrackedFixtures(db, `E2EPUBTHR-${run}`);
    });

    afterAll(async () => {
        if (db) await fixtures.cleanup();
        await app?.close();
    });

    it('blocks the IP after the limit and answers the same whether the token exists or not', async () => {
        const { token } = await fixtures.create();

        // Inside the budget: a real token and unknown ones are told apart only by 200 vs 404 (never by the limit).
        expect((await view(token)).status).toBe(200);
        for (let i = 1; i < LIMIT; i++) expect((await view(UNKNOWN)).status).toBe(404);

        // Over the budget: a wrong token and the right one get the very same answer.
        const wrong = await view(UNKNOWN);
        const right = await view(token);

        expect(wrong.status).toBe(429);
        expect(right.status).toBe(429);
        const strip = ({ timestamp: _t, ...rest }: Record<string, unknown>) => rest;
        expect(strip(right.body)).toEqual(strip(wrong.body));
        expect(wrong.body).toMatchObject({ statusCode: 429, error: 'TOO_MANY_REQUESTS', path: `/${prefix}/public/tracking/:token` });
        expect(JSON.stringify(right.body)).not.toContain(token);
    });

    it('limits only the public page: the rest of the API keeps answering from the same IP', async () => {
        expect((await view(UNKNOWN)).status).toBe(429);

        expect((await http().get(`/${prefix}/health`)).status).toBe(200);
    });
});
