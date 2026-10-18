import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createClient, type RedisClientType } from 'redis';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { SmsSender, type SmsMessage } from '../src/plugins/sms/sms.port.js';
import { DispatchOtpService } from '../src/app/dispatch-otp/dispatch-otp.service.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

// This suite requires explicitly selected disposable PostgreSQL and Redis; no inferred shared services.
describe.skipIf(!process.env.OTP_TEST_REDIS_PORT)('delivery OTP HTTP + PostgreSQL + Redis (ST-31.4)', () => {
    let app: INestApplication;
    let db: DataSource;
    let redis: RedisClientType;
    let prefix: string;
    let otp: DispatchOtpService;
    const run = Date.now().toString(36);
    const sourcePrefix = `ST314-${run}`;
    const users: Record<string, number> = {};
    const tokens: Record<string, string> = {};
    const batchIds: number[] = [];
    const dispatchIds: number[] = [];
    const messages: SmsMessage[] = [];
    let sequence = 0;
    let deliveryTypeId: number;
    const statuses: Record<string, number> = {};
    const auth = (name = 'driver') => ({ Authorization: `Bearer ${tokens[name]}` });
    const resend = (id: number, name = 'driver') => request(app.getHttpServer()).post(`/${prefix}/dispatches/${id}/otp/resend`).set(auth(name)).send();
    const events = (id: number) => db.query(`SELECT event_type, metadata FROM dispatch_events WHERE dispatch_id=$1 AND event_type LIKE 'otp_%' ORDER BY dispatch_event_id`, [id]);
    async function waitUntil(check: () => Promise<boolean>): Promise<void> {
        for (let i = 0; i < 100; i++) {
            if (await check()) return;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error('Expected OTP asynchronous effect was not observed.');
    }
    async function dispatch(phone: string | null = '+59170000123', status = 'out_for_delivery', policy = 'high_value_control'): Promise<number> {
        const [{ route_batch_id: batchId }] = await db.query(`INSERT INTO route_batches (driver_id, shift_date, status) VALUES ($1, DATE '2045-01-01' + $2::int, 'in_execution') RETURNING route_batch_id`, [users.driver, ++sequence]);
        batchIds.push(batchId);
        const [{ dispatch_id: id }] = await db.query(`INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order, source_order_ref, tracking_code, delivery_address, evidence_policy, contact_phone) VALUES ($1,$2,$3,1,$4,$5,'OTP test address',$6,$7) RETURNING dispatch_id`, [deliveryTypeId, statuses[status], batchId, `${sourcePrefix}-${sequence}`, `OTP-${run}-${sequence}`, policy, phone]);
        dispatchIds.push(id);
        return id;
    }
    async function start(id: number): Promise<void> {
        const response = await request(app.getHttpServer()).patch(`/${prefix}/dispatches/${id}/status`).set(auth()).send({ status: 'in_transit', eventId: uuidv7(), occurredAt: new Date().toISOString(), lat: -16.5, lng: -68.1, accuracy: 8 });
        expect(response.status).toBe(200);
    }
    beforeAll(async () => {
        expect(Number(process.env.REDIS_PORT)).toBe(Number(process.env.OTP_TEST_REDIS_PORT));
        redis = createClient({ socket: { host: '127.0.0.1', port: Number(process.env.OTP_TEST_REDIS_PORT) } });
        await redis.connect();
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(SmsSender).useValue({ send: async (message: SmsMessage) => { messages.push(message); } }).compile();
        app = moduleRef.createNestApplication();
        prefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(prefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        db = moduleRef.get(DataSource);
        otp = moduleRef.get(DispatchOtpService);
        const passwordHash = await hashPassword('E2eTest1234');
        for (const [name, role] of [['driver', 'driver'], ['foreign', 'driver'], ['coordinator', 'coordinator']]) {
            const [{ role_id: roleId }] = await db.query('SELECT role_id FROM roles WHERE name=$1', [role]);
            const username = `e2e_st314_${name}_${run}`;
            const [{ user_id: id }] = await db.query(`INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1,$2,$3,$4,false) RETURNING user_id`, [roleId, `OTP test ${name}`, username, passwordHash]);
            users[name] = id;
            const login = await request(app.getHttpServer()).post(`/${prefix}/auth/login`).send({ username, password: 'E2eTest1234' });
            expect(login.status).toBe(200);
            tokens[name] = login.body.accessToken;
        }
        for (const row of await db.query('SELECT name, dispatch_status_id FROM dispatch_statuses')) statuses[row.name] = row.dispatch_status_id;
        [{ dispatch_type_id: deliveryTypeId }] = await db.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name='delivery'`);
    }, 30000);
    afterAll(async () => {
        if (db?.isInitialized) await withEventPurge(db, { dispatchRefs: [`${sourcePrefix}%`], routeBatchIds: batchIds, userNames: [`e2e_st314_%_${run}`] }, async (manager) => {
            await manager.query('DELETE FROM dispatches WHERE source_order_ref LIKE $1', [`${sourcePrefix}%`]);
            await manager.query('DELETE FROM route_batches WHERE route_batch_id=ANY($1::int[])', [batchIds]);
            await manager.query('DELETE FROM users WHERE username LIKE $1', [`e2e_st314_%_${run}`]);
        });
        if (redis?.isOpen) {
            for (const id of dispatchIds) await redis.del([`dispatch-otp:{${id}}:code`, `dispatch-otp:{${id}}:limits`]);
            await redis.quit();
        }
        messages.length = 0;
        await app?.close();
    });
    it('issues on committed in_transit, audits without plaintext, rotates twice and blocks third resend', async () => {
        const id = await dispatch();
        const before = messages.length;
        await start(id);
        await waitUntil(async () => (await events(id)).some((event: { event_type: string }) => event.event_type === 'otp_sent'));
        expect(messages.length).toBe(before + 1);
        const firstCode = messages[before].body.match(/\b\d{6}\b/)?.[0];
        expect(firstCode).toBeDefined();
        const firstHash = await redis.get(`dispatch-otp:{${id}}:code`);
        expect(firstHash).toBeTruthy();
        expect(firstHash).not.toContain(firstCode!);
        expect(await redis.ttl(`dispatch-otp:{${id}}:code`)).toBeGreaterThan(3500);
        for (let n = 0; n < 2; n++) {
            const response = await resend(id);
            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ sent: true });
            expect(response.body).not.toHaveProperty('code');
        }
        expect(await redis.get(`dispatch-otp:{${id}}:code`)).not.toBe(firstHash);
        expect((await resend(id)).body.error).toBe('OTP_RESEND_LIMIT');
        const audit = JSON.stringify(await events(id));
        for (const message of messages.slice(before)) expect(audit).not.toContain(message.body.match(/\b\d{6}\b/)![0]);
    });
    it('denies unauthenticated, foreign-driver and non-driver resends without sending', async () => {
        const id = await dispatch('+59170000123', 'in_transit');
        const before = messages.length;
        expect((await request(app.getHttpServer()).post(`/${prefix}/dispatches/${id}/otp/resend`)).status).toBe(401);
        expect((await resend(id, 'foreign')).status).toBe(403);
        expect((await resend(id, 'coordinator')).status).toBe(403);
        expect(messages.length).toBe(before);
        expect(await redis.get(`dispatch-otp:{${id}}:code`)).toBeNull();
    });
    it('marks missing verified contact for Dispatch without generating a token or changing policy', async () => {
        const id = await dispatch(null);
        const before = messages.length;
        await start(id);
        await waitUntil(async () => (await events(id)).some((event: { event_type: string }) => event.event_type === 'otp_resolution_required'));
        expect(messages.length).toBe(before);
        expect(await redis.get(`dispatch-otp:{${id}}:code`)).toBeNull();
        const response = await resend(id);
        expect(response.status).toBe(409);
        expect(response.body.error).toBe('OTP_CONTACT_REQUIRED');
        expect((await db.query('SELECT evidence_policy FROM dispatches WHERE dispatch_id=$1', [id]))[0].evidence_policy).toBe('high_value_control');
    });
    it('keeps failed attempts through resend and blocks after the third failure', async () => {
        const id = await dispatch();
        await start(id);
        await waitUntil(async () => (await events(id)).some((event: { event_type: string }) => event.event_type === 'otp_sent'));
        expect(await otp.verify(id, 'wrong-code')).toBe('invalid');
        expect((await resend(id)).status).toBe(200);
        expect(await otp.verify(id, 'wrong-code')).toBe('invalid');
        expect(await otp.verify(id, 'wrong-code')).toBe('locked');
        expect((await resend(id)).body.error).toBe('OTP_LOCKED');
    });
});
