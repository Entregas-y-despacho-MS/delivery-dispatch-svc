import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createClient, type RedisClientType } from 'redis';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { SmsSender, type SmsMessage } from '../src/plugins/sms/sms.port.js';
import { StoragePort } from '../src/plugins/storage/storage.port.js';
import { DispatchOtpService } from '../src/app/dispatch-otp/dispatch-otp.service.js';
import { DISPATCH_EVIDENCE_REGISTERED_EVENT } from '../src/app/dispatch-evidence/dispatch-evidence-registered.event.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

const PNG  = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 2)]);

// The OTP cases need an explicitly selected disposable Redis (OTP_TEST_REDIS_PORT, same as dispatch-otp.e2e-spec.ts);
// without it they are skipped and the signature/photo cases still run against PostgreSQL.
const redisPort = process.env.OTP_TEST_REDIS_PORT;

describe('delivery evidence: signature, photo and OTP over HTTP + PostgreSQL (ST-31.3)', () => {
    let app: INestApplication;
    let db: DataSource;
    let redis: RedisClientType | undefined;
    let otp: DispatchOtpService;
    let prefix: string;
    const run = Date.now().toString(36);
    const sourcePrefix = `ST313-${run}`;
    const users: Record<string, number> = {};
    const tokens: Record<string, string> = {};
    const batchIds: number[] = [];
    const dispatchIds: number[] = [];
    const messages: SmsMessage[] = [];
    const uploads: string[] = [];
    const announced: Array<Record<string, unknown>> = [];
    const statuses: Record<string, number> = {};
    let deliveryTypeId: number;
    let sequence = 0;
    const auth = (name = 'driver') => ({ Authorization: `Bearer ${tokens[name]}` });

    async function dispatch(status = 'in_transit', policy = 'hand_delivery_standard'): Promise<number> {
        const [{ route_batch_id: batchId }] = await db.query(`INSERT INTO route_batches (driver_id, shift_date, status) VALUES ($1, DATE '2046-01-01' + $2::int, 'in_execution') RETURNING route_batch_id`, [users.driver, ++sequence]);
        batchIds.push(batchId);
        const [{ dispatch_id: id }] = await db.query(`INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order, source_order_ref, tracking_code, delivery_address, evidence_policy, contact_phone) VALUES ($1,$2,$3,1,$4,$5,'Evidence test address',$6,'+59170000123') RETURNING dispatch_id`, [deliveryTypeId, statuses[status], batchId, `${sourcePrefix}-${sequence}`, `EV-${run}-${sequence}`, policy]);
        dispatchIds.push(id);
        return id;
    }
    const fields = (type: 'signature' | 'photo', override: Record<string, string> = {}): Record<string, string> => ({
        evidenceId: uuidv7(), type, capturedAt: new Date(Date.now() - 60_000).toISOString(), lat: '-17.783327', lng: '-63.182140',
        ...(type === 'signature' ? { receiverName: 'Maria Lopez', receiverDocument: '1234567' } : {}), ...override,
    });
    function upload(id: number, values: Record<string, string>, file: { buffer: Buffer; contentType: string; filename: string } | null, who = 'driver') {
        let req = request(app.getHttpServer()).post(`/${prefix}/dispatches/${id}/evidences`).set(auth(who));
        for (const [key, value] of Object.entries(values)) req = req.field(key, value);
        return file ? req.attach('file', file.buffer, { filename: file.filename, contentType: file.contentType }) : req;
    }
    const signature = { buffer: PNG, contentType: 'image/png', filename: 'sig.png' };
    const photo = { buffer: JPEG, contentType: 'image/jpeg', filename: 'photo.jpg' };
    const validate = (id: number, code: string, who = 'driver') => request(app.getHttpServer()).post(`/${prefix}/dispatches/${id}/otp/validate`).set(auth(who)).send({ code });
    const rows = (id: number) => db.query('SELECT * FROM delivery_evidences WHERE dispatch_id=$1', [id]);
    /** Issues the code the way the status change does and reads it from the simulated SMS, the only place it exists. */
    async function issuedCode(id: number): Promise<string> {
        const before = messages.length;
        await otp.onInTransit(id);
        expect(messages.length).toBe(before + 1);
        return messages[before].body.match(/\b\d{6}\b/)![0];
    }

    beforeAll(async () => {
        if (redisPort) {
            expect(Number(process.env.REDIS_PORT)).toBe(Number(redisPort));
            redis = createClient({ socket: { host: '127.0.0.1', port: Number(redisPort) } });
            await redis.connect();
        }
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(SmsSender).useValue({ send: async (message: SmsMessage) => { messages.push(message); } })
            // Never write test files to the real storage (local disk or Cloudinary).
            .overrideProvider(StoragePort).useValue({
                upload: async ({ filename }: { filename: string }) => { uploads.push(filename); return { url: `https://files.test/${filename}` }; },
                getAccessUrl: async (url: string) => ({ url, expiresAt: new Date() }),
            })
            .compile();
        app = moduleRef.createNestApplication();
        prefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(prefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        db = moduleRef.get(DataSource);
        otp = moduleRef.get(DispatchOtpService);
        app.get(EventEmitter2).on(DISPATCH_EVIDENCE_REGISTERED_EVENT, (event: Record<string, unknown>) => { announced.push(event); });
        const passwordHash = await hashPassword('E2eTest1234');
        for (const [name, role] of [['driver', 'driver'], ['foreign', 'driver'], ['coordinator', 'coordinator']]) {
            const [{ role_id: roleId }] = await db.query('SELECT role_id FROM roles WHERE name=$1', [role]);
            const username = `e2e_st313_${name}_${run}`;
            const [{ user_id: id }] = await db.query(`INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1,$2,$3,$4,false) RETURNING user_id`, [roleId, `Evidence test ${name}`, username, passwordHash]);
            users[name] = id;
            const login = await request(app.getHttpServer()).post(`/${prefix}/auth/login`).send({ username, password: 'E2eTest1234' });
            expect(login.status).toBe(200);
            tokens[name] = login.body.accessToken;
        }
        for (const row of await db.query('SELECT name, dispatch_status_id FROM dispatch_statuses')) statuses[row.name] = row.dispatch_status_id;
        [{ dispatch_type_id: deliveryTypeId }] = await db.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name='delivery'`);
    }, 30000);

    afterAll(async () => {
        if (db?.isInitialized) await withEventPurge(db, { dispatchRefs: [`${sourcePrefix}%`], routeBatchIds: batchIds, userNames: [`e2e_st313_%_${run}`] }, async (manager) => {
            await manager.query('DELETE FROM delivery_evidences WHERE dispatch_id=ANY($1::int[])', [dispatchIds]);
            await manager.query('DELETE FROM dispatches WHERE source_order_ref LIKE $1', [`${sourcePrefix}%`]);
            await manager.query('DELETE FROM route_batches WHERE route_batch_id=ANY($1::int[])', [batchIds]);
            await manager.query('DELETE FROM users WHERE username LIKE $1', [`e2e_st313_%_${run}`]);
        });
        if (redis?.isOpen) {
            for (const id of dispatchIds) await redis.del([`dispatch-otp:{${id}}:code`, `dispatch-otp:{${id}}:limits`]);
            await redis.quit();
        }
        await app?.close();
    });

    it('registers a signature: 201, only the URL is stored and the control tower is told', async () => {
        const id = await dispatch();
        const values = fields('signature');
        const response = await upload(id, values, signature);
        expect(response.status).toBe(201);
        expect(response.body).toMatchObject({ id: values.evidenceId, dispatchId: id, type: 'signature', receiverName: 'Maria Lopez', receiverDocument: '1234567', latitude: -17.783327, longitude: -63.18214 });
        expect(response.body).not.toHaveProperty('fileUrl');
        const [row] = await rows(id);
        expect(row.file_url).toMatch(/^https:\/\/files\.test\//);
        expect(row.otp_code).toBeNull();
        expect(new Date(row.captured_at).toISOString()).toBe(new Date(values.capturedAt).toISOString());
        expect(announced).toContainEqual(expect.objectContaining({ dispatchId: id, evidenceId: values.evidenceId, type: 'signature' }));
        // The 360° file (ST-56.2) shows the capture data and the receiver this endpoint stored.
        const file = await request(app.getHttpServer()).get(`/${prefix}/dispatches/${id}/detail`).set(auth('coordinator'));
        expect(file.status).toBe(200);
        expect(file.body.receiver).toMatchObject({ id: values.evidenceId, receiverName: 'Maria Lopez', receiverDocument: '1234567' });
        expect(file.body.evidences[0]).toMatchObject({ type: 'signature', latitude: -17.783327, longitude: -63.18214 });
        // Registering evidence never delivers the dispatch: that is the status endpoint's job (ST-30.3).
        expect((await db.query('SELECT s.name FROM dispatches d JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id WHERE d.dispatch_id=$1', [id]))[0].name).toBe('in_transit');
    });

    it('registers a photo: 201, with no receiver data even if the app sends it', async () => {
        const id = await dispatch('in_transit', 'contactless_delivery');
        const values = fields('photo', { receiverName: 'Ignored Person', receiverDocument: '999' });
        const response = await upload(id, values, photo);
        expect(response.status).toBe(201);
        expect(response.body).toMatchObject({ type: 'photo', receiverName: null, receiverDocument: null });
        expect(announced).toContainEqual(expect.objectContaining({ dispatchId: id, type: 'photo' }));
    });

    it('answers 413 for a file over 500 KB and stores nothing', async () => {
        const id = await dispatch();
        const stored = uploads.length;
        const big = Buffer.concat([PNG, Buffer.alloc(501 * 1024, 3)]);
        const response = await upload(id, fields('signature'), { buffer: big, contentType: 'image/png', filename: 'big.png' });
        expect(response.status).toBe(413);
        expect(await rows(id)).toHaveLength(0);
        expect(uploads.length).toBe(stored);
    });

    it('answers 415 when the file is not the image the type needs, whatever it declares', async () => {
        const id = await dispatch();
        const stored = uploads.length;
        expect((await upload(id, fields('signature'), photo)).status).toBe(415);
        expect((await upload(id, fields('photo'), signature)).status).toBe(415);
        expect((await upload(id, fields('photo'), { buffer: Buffer.from('<html><script>1</script></html>'), contentType: 'image/jpeg', filename: 'x.jpg' })).status).toBe(415);
        expect((await upload(id, fields('signature'), { buffer: Buffer.from('plain text'), contentType: 'text/plain', filename: 'x.txt' })).status).toBe(415);
        expect(await rows(id)).toHaveLength(0);
        expect(uploads.length).toBe(stored);
    });

    it('answers 400 for missing or invalid fields and for a missing file', async () => {
        const id = await dispatch();
        expect((await upload(id, fields('signature'), null)).status).toBe(400);
        expect((await upload(id, fields('signature', { evidenceId: 'not-a-uuid' }), signature)).status).toBe(400);
        expect((await upload(id, fields('signature', { evidenceId: '3f1c8a52-4d1e-4b6a-9c3e-1a2b3c4d5e6f' }), signature)).status).toBe(400);
        expect((await upload(id, fields('signature', { type: 'otp' }), signature)).status).toBe(400);
        expect((await upload(id, fields('signature', { lat: '91' }), signature)).status).toBe(400);
        expect((await upload(id, fields('signature', { lng: 'abc' }), signature)).status).toBe(400);
        expect((await upload(id, fields('signature', { capturedAt: 'yesterday' }), signature)).status).toBe(400);
        expect((await upload(id, fields('signature', { capturedAt: new Date(Date.now() + 3_600_000).toISOString() }), signature)).status).toBe(400);
        expect((await upload(id, fields('signature', { receiverName: 'Al' }), signature)).status).toBe(400);
        const { receiverDocument: _omitted, ...withoutDocument } = fields('signature');
        expect((await upload(id, withoutDocument, signature)).status).toBe(400);
        expect(await rows(id)).toHaveLength(0);
    });

    it('answers the original record with 200 when the same evidenceId is sent again, without a second file or event', async () => {
        const id = await dispatch();
        const values = fields('signature');
        const first = await upload(id, values, signature);
        expect(first.status).toBe(201);
        const stored = uploads.length;
        const events = announced.length;
        const again = await upload(id, { ...values, receiverName: 'Somebody Else' }, signature);
        expect(again.status).toBe(200);
        expect(again.body).toEqual(first.body);
        expect(again.body.receiverName).toBe('Maria Lopez');
        expect(await rows(id)).toHaveLength(1);
        expect(uploads.length).toBe(stored);
        expect(announced.length).toBe(events);
        const other = await dispatch();
        expect((await upload(other, values, signature)).status).toBe(409);
    });

    it('accepts concurrent retries of one evidenceId and keeps a single row', async () => {
        const id = await dispatch();
        const values = fields('photo');
        const results = await Promise.all(Array.from({ length: 4 }, () => upload(id, values, photo)));
        expect(results.every((response) => response.status === 201 || response.status === 200)).toBe(true);
        expect(results.filter((response) => response.status === 201).length).toBeGreaterThanOrEqual(1);
        expect(await rows(id)).toHaveLength(1);
    });

    it('denies unauthenticated, non-driver and foreign-driver uploads and unknown dispatches', async () => {
        const id = await dispatch();
        const values = fields('signature');
        expect((await request(app.getHttpServer()).post(`/${prefix}/dispatches/${id}/evidences`).field('evidenceId', values.evidenceId)).status).toBe(401);
        expect((await upload(id, values, signature, 'coordinator')).status).toBe(403);
        expect((await upload(id, values, signature, 'foreign')).status).toBe(403);
        expect((await upload(2147483000, values, signature)).status).toBe(404);
        expect((await upload(0, values, signature)).status).toBe(400);
        expect(await rows(id)).toHaveLength(0);
    });

    describe.skipIf(!redisPort)('delivery OTP', () => {
        it('validates the right code once: evidence otp without the code, then 409 on reuse', async () => {
            const id = await dispatch('in_transit', 'high_value_control');
            const code = await issuedCode(id);
            const response = await validate(id, code);
            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ dispatchId: id, type: 'otp', capturedAt: expect.any(String), receiverName: null });
            const [row] = await rows(id);
            expect(row).toMatchObject({ type: 'otp', file_url: null, otp_code: null });
            expect(JSON.stringify([row, response.body])).not.toContain(code);
            expect(announced).toContainEqual(expect.objectContaining({ dispatchId: id, type: 'otp' }));
            expect((await db.query('SELECT 1 FROM dispatch_events WHERE dispatch_id=$1 AND metadata::text LIKE $2', [id, `%${code}%`]))).toHaveLength(0);
            const reuse = await validate(id, code);
            expect(reuse.status).toBe(409);
            expect(reuse.body.error).toBe('OTP_CONSUMED');
            expect(await rows(id)).toHaveLength(1);
        });

        it('answers 422 for a wrong code, registers nothing and still accepts the right one afterwards', async () => {
            const id = await dispatch('in_transit', 'high_value_control');
            const code = await issuedCode(id);
            const wrong = code === '000000' ? '111111' : '000000';
            const response = await validate(id, wrong);
            expect(response.status).toBe(422);
            expect(response.body.error).toBe('OTP_INVALID');
            expect(await rows(id)).toHaveLength(0);
            expect((await validate(id, code)).status).toBe(200);
        });

        it('locks on the third consecutive wrong code with 423 and then rejects even the right one', async () => {
            const id = await dispatch('in_transit', 'high_value_control');
            const code = await issuedCode(id);
            const wrong = code === '000000' ? '111111' : '000000';
            expect((await validate(id, wrong)).status).toBe(422);
            expect((await validate(id, wrong)).status).toBe(422);
            const third = await validate(id, wrong);
            expect(third.status).toBe(423);
            expect(third.body.error).toBe('OTP_LOCKED');
            expect(third.body.message).toContain('ES-32');
            const afterLock = await validate(id, code);
            expect(afterLock.status).toBe(423);
            expect(await rows(id)).toHaveLength(0);
        });

        it('rejects a malformed code with 400 without spending an attempt, and denies other drivers and policies', async () => {
            const id = await dispatch('in_transit', 'high_value_control');
            const code = await issuedCode(id);
            expect((await validate(id, 'abc')).status).toBe(400);
            expect((await validate(id, '123')).status).toBe(400);
            expect((await validate(id, code, 'foreign')).status).toBe(403);
            expect((await validate(id, code, 'coordinator')).status).toBe(403);
            expect((await request(app.getHttpServer()).post(`/${prefix}/dispatches/${id}/otp/validate`).send({ code })).status).toBe(401);
            const standard = await dispatch('in_transit', 'hand_delivery_standard');
            const notApplicable = await validate(standard, '123456');
            expect(notApplicable.status).toBe(409);
            expect(notApplicable.body.error).toBe('OTP_NOT_APPLICABLE');
            expect((await validate(2147483000, '123456')).status).toBe(404);
            expect((await validate(id, code)).status).toBe(200);
        });

        it('answers 409 OTP_EXPIRED when no code is alive', async () => {
            const id = await dispatch('in_transit', 'high_value_control');
            const response = await validate(id, '123456');
            expect(response.status).toBe(409);
            expect(response.body.error).toBe('OTP_EXPIRED');
        });
    });
});
