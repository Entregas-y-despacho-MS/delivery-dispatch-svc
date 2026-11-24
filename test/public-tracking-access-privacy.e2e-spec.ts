// ST-309.3 — Privacy and resistance to enumeration of the access to the tracking page by tracking code + one-time code.
//
// `public-tracking-access.e2e-spec.ts` (ST-309.1) proves the flow works: a session opens, a code is used once, the
// basic limits exist. This suite attacks it instead, the way a third party would:
//   - enumeration: whole answers (status, body, headers) and response TIMES compared between an existing code and every
//     kind of non-existing one, including a slow and a failing mail server;
//   - limits: per tracking code (shared by any spelling of the code, never reset by a new code) and per client IP
//     (a forged X-Forwarded-For does not reset it), and the concurrency of the cooldown;
//   - brute force: a code of another dispatch, the burn audited once, a code whose email failed;
//   - scope of the session: revoked, expired by its own record, tampered, sent in a URL or as a bearer token, used as a
//     link token to act on the dispatch, and mixed up with the rescheduling code of the link (ES-224);
//   - privacy at rest and in the trail: what the cache keeps (only fingerprints, a bcrypt hash and {dispatchId,
//     expiresAt}, with its TTLs), the logs (spied, including an SMTP error carrying the address), dispatch_events,
//     customer_notifications, outbound_messages and the audit tables.
//
// Time never comes from fake timers: expiry is forced by expiring the key in the cache or by rewriting the stored record,
// so the suite gives the same result with the in-memory cache (default) and with a real Redis:
//   docker run -d --name tracking-e2e-redis -p 127.0.0.1:46393:6379 redis:7-alpine
//   TRACKING_ACCESS_E2E_REDIS_PORT=46393 DB_...=... npx vitest run --config ./vitest.config.e2e.ts public-tracking-access-privacy
// The per-IP limit is the real one (20 per minute); the throttler is emptied before every test.
import { createHash, randomInt } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ThrottlerStorageService, getStorageToken } from '@nestjs/throttler';
import { createClient } from 'redis';
import request from 'supertest';
import { DataSource } from 'typeorm';
import type { CacheService as CacheServiceType } from '../src/plugins/cache/cache.port.js';
import type { MailOptions } from '../src/plugins/mailer/mailer.port.js';
import type { TrackingAccessService as TrackingAccessServiceType } from '../src/app/public-tracking/services/tracking-access.service.js';
import type { SettingsService as SettingsServiceType } from '../src/modules/settings/services/settings.service.js';
import { TrackedFixtures } from './helpers/tracked-dispatch.fixtures.js';

const IP_LIMIT = 20;
/** Settings this suite pins (the rescheduling code of the link needs the preparation lead to leave its slot open). */
const PINNED_SETTINGS: Record<string, string> = { reschedule_code_expiry_minutes: '10', warehouse_prep_lead_minutes: '60' };
const TTL = 600;
const REDIS_PORT = process.env.TRACKING_ACCESS_E2E_REDIS_PORT;
const ACCESS_TEMPLATE = 'tracking-access-code';

type MailMode = 'sent' | 'bounced' | 'throws';
type Res = request.Response;

/** What the suite reads and changes directly in the store of codes and sessions, whatever adapter the app runs on. */
interface AtRest {
    keys(): Promise<string[]>;
    ttlSeconds(key: string): Promise<number | null>;
    expire(key: string): Promise<void>;
    remove(keys: string[]): Promise<void>;
    close(): Promise<void>;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const fingerprintOf = (trackingCode: string): string => sha256(trackingCode.trim().toUpperCase());
const accessKey = (kind: string, trackingCode: string): string => `public-tracking:access:${kind}:${fingerprintOf(trackingCode)}`;
const sessionKey = (session: string): string => `public-tracking:access-session:${sha256(session)}`;
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Everything a client sees of an error except the instant it was produced. */
const comparable = (res: Res): Record<string, unknown> => {
    const { timestamp: _timestamp, ...rest } = res.body as Record<string, unknown>;
    return { status: res.status, ...rest };
};
/** Header names and values a client sees, without the ones that change on every request. */
const visibleHeaders = (res: Res): Record<string, string> => Object.fromEntries(
    Object.entries(res.headers)
        .filter(([name]) => !['date', 'etag', 'content-length', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-request-id', 'connection', 'keep-alive'].includes(name))
        .map(([name, value]) => [name, String(value)]),
);

// Several tests make dozens of requests, each with a bcrypt: more than the default 5 s.
describe('Tracking access: privacy and resistance to enumeration (e2e, ST-309.3)', { timeout: 30_000 }, () => {
    let app: INestApplication;
    let db: DataSource;
    let cache: CacheServiceType;
    let access: TrackingAccessServiceType;
    let settings: SettingsServiceType;
    let throttler: ThrottlerStorageService;
    let atRest: AtRest;
    let fixtures: TrackedFixtures;
    let prefix: string;
    const originalSettings = new Map<string, string>();
    let driverUserId: number | null = null;
    const startedAt = new Date();

    const run = Date.now().toString(36).toUpperCase();
    const mails: MailOptions[] = [];
    const logs: string[] = [];
    let mailMode: MailMode = 'sent';
    let mailDelayMs = 0;
    /** Tracking codes and sessions this suite touched, to remove their keys from a real Redis at the end. */
    const touchedCodes = new Set<string>();
    const touchedSessions = new Set<string>();
    const otherKeys = new Set<string>();

    const http = () => request(app.getHttpServer());
    const base = () => `/${prefix}/public/tracking`;
    const askCode = (trackingCode: string, forwardedFor?: string): request.Test => {
        touchedCodes.add(trackingCode);
        const req = http().post(`${base()}/access/code`).send({ trackingCode });
        return forwardedFor ? req.set('X-Forwarded-For', forwardedFor) : req;
    };
    const verify = (trackingCode: string, code: string, forwardedFor?: string): request.Test => {
        touchedCodes.add(trackingCode);
        const req = http().post(`${base()}/access/verify`).send({ trackingCode, code });
        return forwardedFor ? req.set('X-Forwarded-For', forwardedFor) : req;
    };
    const view = (session: string): request.Test => http().get(`${base()}/access/view`).set('X-Tracking-Session', session);
    /** A well-formed tracking code no dispatch will ever have (year 2099), different on every call and every run. */
    const unknownCode = (): string => `DSP-2099-${randomInt(10_000_000, 100_000_000)}`;
    const wrongOf = (code: string): string => (code === '000000' ? '111111' : '000000');
    const accessMails = () => mails.filter((mail) => mail.template === ACCESS_TEMPLATE);
    const lastAccessCode = (): string => String(accessMails().at(-1)!.context!.code);

    async function codeFor(trackingCode: string): Promise<string> {
        const before = accessMails().length;
        const res = await askCode(trackingCode);
        expect(res.status).toBe(200);
        await access.whenIdle();
        expect(accessMails().length).toBe(before + 1);
        return lastAccessCode();
    }

    async function sessionFor(trackingCode: string): Promise<string> {
        const res = await verify(trackingCode, await codeFor(trackingCode));
        expect(res.status).toBe(200);
        touchedSessions.add(res.body.session);
        return res.body.session;
    }

    /** Lets the same tracking code ask again right away, as if the 60 s cooldown had passed. */
    const endCooldown = async (trackingCode: string): Promise<void> => await atRest.expire(accessKey('cooldown', trackingCode));

    const accessEvents = async (dispatchId: number): Promise<{ event_type: string; actor_type: string; reason: string | null; metadata: unknown }[]> => await db.query(
        `SELECT event_type, actor_type, reason, metadata FROM dispatch_events
          WHERE dispatch_id = $1 AND event_type LIKE 'tracking_access_%' ORDER BY dispatch_event_id`,
        [dispatchId],
    );

    async function timed(send: () => request.Test): Promise<{ res: Res; ms: number }> {
        const started = performance.now();
        const res = await send();
        return { res, ms: performance.now() - started };
    }

    beforeAll(async () => {
        // Read when the modules are loaded, so they are set before the app is imported.
        process.env.THROTTLE_PUBLIC_TRACKING_LIMIT = String(IP_LIMIT);
        process.env.THROTTLE_TTL_MS = '60000';
        process.env.TRUST_PROXY = '';
        if (REDIS_PORT) {
            process.env.CACHE_ADAPTER = 'redis';
            process.env.REDIS_HOST = '127.0.0.1';
            process.env.REDIS_PORT = REDIS_PORT;
            process.env.REDIS_PASSWORD = '';
            process.env.REDIS_TLS = 'false';
        }
        const { Test } = await import('@nestjs/testing');
        const { AppModule } = await import('../src/app.module.js');
        const { AppConfig } = await import('../src/config/services/app.config.js');
        const { MailerPort } = await import('../src/plugins/mailer/mailer.port.js');
        const { CacheService } = await import('../src/plugins/cache/cache.port.js');
        const { TrackingAccessService } = await import('../src/app/public-tracking/services/tracking-access.service.js');
        const { SettingsService } = await import('../src/modules/settings/services/settings.service.js');
        const { HttpExceptionFilter } = await import('../src/shared/filters/index.js');

        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(MailerPort)
            .useValue({
                send: async (mail: MailOptions) => {
                    if (mailDelayMs > 0) await sleep(mailDelayMs);
                    mails.push(mail);
                    if (mailMode === 'throws') throw new Error(`550 5.1.1 <${String(mail.to)}>: mailbox unavailable`);
                    return { status: mailMode === 'bounced' ? 'bounced' : 'sent' };
                },
            })
            .compile();
        app = moduleRef.createNestApplication();
        const cfg = app.get(AppConfig);
        prefix = cfg.apiPrefix;
        app.setGlobalPrefix(prefix);
        // As main.ts: with TRUST_PROXY unset the client IP is the socket's, never X-Forwarded-For.
        if (cfg.trustProxy !== false) app.getHttpAdapter().getInstance().set('trust proxy', cfg.trustProxy);
        app.useGlobalPipes(new ValidationPipe({
            transform: true, whitelist: true, forbidNonWhitelisted: true,
            transformOptions: { enableImplicitConversion: false },
        }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();

        db = moduleRef.get(DataSource);
        cache = moduleRef.get(CacheService);
        access = moduleRef.get(TrackingAccessService);
        settings = moduleRef.get(SettingsService);
        throttler = app.get<ThrottlerStorageService>(getStorageToken());
        fixtures = new TrackedFixtures(db, `E2EACCPRIV-${run}`);
        atRest = REDIS_PORT ? await redisAtRest(Number(REDIS_PORT)) : memoryAtRest(cache);

        for (const [key, value] of Object.entries(PINNED_SETTINGS)) {
            const [row] = await db.query(`SELECT setting_value FROM settings WHERE setting_key = $1`, [key]);
            originalSettings.set(key, row?.setting_value ?? '');
            await db.query(`UPDATE settings SET setting_value = $2, updated_at = NOW() WHERE setting_key = $1`, [key, value]);
        }
        await settings.refresh();

        // Every line any logger of the app writes, as text, without printing it.
        const capture = (...args: unknown[]): void => {
            logs.push(args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
        };
        for (const level of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const) {
            vi.spyOn(Logger.prototype, level).mockImplementation(capture);
            vi.spyOn(Logger, level).mockImplementation(capture);
        }
        for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, level).mockImplementation(capture);
    });

    beforeEach(() => {
        throttler.storage.clear();
    });

    afterEach(async () => {
        await access.whenIdle();
        mailMode = 'sent';
        mailDelayMs = 0;
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        if (db) {
            await access.whenIdle();
            for (const [key, value] of originalSettings) {
                await db.query(`UPDATE settings SET setting_value = $2, updated_at = NOW() WHERE setting_key = $1`, [key, value]);
            }
            await settings.refresh();
            await fixtures.cleanup();
            if (driverUserId !== null) await db.query(`DELETE FROM users WHERE user_id = $1`, [driverUserId]);
        }
        if (atRest) {
            const kinds = ['code', 'attempts', 'verifies', 'sends', 'cooldown'];
            await atRest.remove([
                ...[...touchedCodes].flatMap((code) => kinds.map((kind) => accessKey(kind, code))),
                ...[...touchedSessions].map(sessionKey),
                ...otherKeys,
            ]);
            await atRest.close();
        }
        await app?.close();
    });

    describe('enumeration', () => {
        it('gives the very same answer to request and verify for an existing code and for every kind of code that leads nowhere', async () => {
            const real = await fixtures.create();
            const noEmail = await fixtures.create({ email: null });
            const expiredLink = await fixtures.create({ tokenExpiresAt: new Date(Date.now() - 60_000) });
            const pickup = await fixtures.create();
            await db.query(
                `UPDATE dispatches SET dispatch_type_id = (SELECT dispatch_type_id FROM dispatch_types WHERE name = 'supplier_pickup') WHERE dispatch_id = $1`,
                [pickup.dispatchId],
            );
            const bouncing = await fixtures.create();
            const candidates = [
                real.trackingCode, noEmail.trackingCode, expiredLink.trackingCode, pickup.trackingCode, bouncing.trackingCode,
                unknownCode(), 'DSP-26-1', "x'; DROP TABLE dispatches; --",
            ];

            const mailsBefore = accessMails().length;
            const asked: Res[] = [];
            for (const trackingCode of candidates) {
                mailMode = trackingCode === bouncing.trackingCode ? 'bounced' : 'sent';
                asked.push(await askCode(trackingCode));
                await access.whenIdle();
            }
            mailMode = 'sent';
            for (const res of asked) {
                expect(res.status).toBe(200);
                expect(res.body).toEqual({ accepted: true, expiresInSeconds: TTL });
                expect(visibleHeaders(res)).toEqual(visibleHeaders(asked[0]));
                expect(res.headers['content-length']).toBe(asked[0].headers['content-length']);
            }
            // Mail goes only to the two deliveries that have an email and a live link.
            expect(accessMails().length).toBe(mailsBefore + 2);
            expect(new Set(accessMails().slice(-2).map((mail) => mail.metadata?.dispatchId))).toEqual(new Set([real.dispatchId, bouncing.dispatchId]));

            const verified: Res[] = [];
            for (const trackingCode of candidates) verified.push(await verify(trackingCode, '123456'));
            for (const res of verified) {
                expect(comparable(res)).toEqual(comparable(verified[0]));
                expect(visibleHeaders(res)).toEqual(visibleHeaders(verified[0]));
            }
            expect(comparable(verified[0])).toMatchObject({ status: 400, error: 'INVALID_ACCESS_CODE' });
            for (const trackingCode of candidates) expect(JSON.stringify(verified.map((res) => res.body))).not.toContain(trackingCode);
        });

        it('gives the very same 429 for an existing and an unknown code on both limits', async () => {
            const real = await fixtures.create();
            const unknown = unknownCode();

            const sendLimited: Res[] = [];
            for (const trackingCode of [real.trackingCode, unknown]) {
                for (let i = 0; i < 3; i++) {
                    expect((await askCode(trackingCode)).status).toBe(200);
                    await endCooldown(trackingCode);
                }
                sendLimited.push(await askCode(trackingCode));
            }
            const verifyLimited: Res[] = [];
            for (const trackingCode of [real.trackingCode, unknown]) {
                throttler.storage.clear();
                for (let i = 0; i < 10; i++) expect((await verify(trackingCode, '123456')).status).toBe(400);
                verifyLimited.push(await verify(trackingCode, '123456'));
            }

            expect(comparable(sendLimited[0])).toMatchObject({ status: 429, error: 'TRACKING_ACCESS_RATE_LIMITED' });
            expect(comparable(sendLimited[1])).toEqual(comparable(sendLimited[0]));
            expect(comparable(verifyLimited[0])).toMatchObject({ status: 429, error: 'TRACKING_ACCESS_RATE_LIMITED' });
            expect(comparable(verifyLimited[1])).toEqual(comparable(verifyLimited[0]));
            for (const res of [...sendLimited, ...verifyLimited]) expect(JSON.stringify(res.body)).not.toContain(real.trackingCode);
        });

        it('takes the same time for an existing and an unknown code, even when the mail server is slow', async () => {
            const reals = await Promise.all(Array.from({ length: 5 }, () => fixtures.create()));
            const unknowns = Array.from({ length: 5 }, unknownCode);
            // Warm-up: the first bcrypt and the first query of each path are slower than the rest.
            await askCode(unknownCode());
            await verify(unknownCode(), '123456');

            mailDelayMs = 1_500;
            const realAsk: number[] = [];
            const unknownAsk: number[] = [];
            for (let i = 0; i < 5; i++) {
                const known = await timed(() => askCode(reals[i].trackingCode));
                const other = await timed(() => askCode(unknowns[i]));
                expect([known.res.status, other.res.status]).toEqual([200, 200]);
                realAsk.push(known.ms);
                unknownAsk.push(other.ms);
            }
            // The answer never waits for the mail: a code that exists is not told apart by a 1.5 s delay.
            expect(Math.max(...realAsk)).toBeLessThan(mailDelayMs);
            await access.whenIdle();
            mailDelayMs = 0;

            // A wrong code: for a real code issued, for a decoy issued (the unknowns above) and for a code never asked for.
            const neverAsked = Array.from({ length: 5 }, unknownCode);
            const realVerify: number[] = [];
            const decoyVerify: number[] = [];
            const nothingVerify: number[] = [];
            for (let i = 0; i < 5; i++) {
                const right = String(mails.find((mail) => mail.metadata?.dispatchId === reals[i].dispatchId)!.context!.code);
                realVerify.push((await timed(() => verify(reals[i].trackingCode, wrongOf(right)))).ms);
                decoyVerify.push((await timed(() => verify(unknowns[i], '123456'))).ms);
                nothingVerify.push((await timed(() => verify(neverAsked[i], '123456'))).ms);
            }

            // Each path does one bcrypt (≈ tens of ms); a path that skipped it would be several times faster.
            const similar = (a: number[], b: number[]): void => {
                const [x, y] = [median(a), median(b)];
                expect(Math.min(x, y) / Math.max(x, y), `medians ${x.toFixed(1)} ms vs ${y.toFixed(1)} ms`).toBeGreaterThan(0.5);
            };
            similar(realAsk, unknownAsk);
            similar(realVerify, decoyVerify);
            similar(realVerify, nothingVerify);
        });
    });
});

/** The in-memory adapter keeps two maps; the suite reads them to see what is stored and for how long. */
function memoryAtRest(cache: CacheServiceType): AtRest {
    const values = Reflect.get(cache, 'values') as Map<string, string> | undefined;
    const expiresAt = Reflect.get(cache, 'expiresAt') as Map<string, number> | undefined;
    if (!values || !expiresAt) throw new Error('The cache is not the in-memory adapter.');
    return {
        keys: async () => [...values.keys()].filter((key) => key.startsWith('public-tracking:access')),
        ttlSeconds: async (key) => {
            const limit = expiresAt.get(key);
            return values.has(key) && limit !== undefined ? Math.round((limit - Date.now()) / 1000) : null;
        },
        // The key stays until the adapter itself evicts it on the next read, as a real expiry.
        expire: async (key) => {
            if (values.has(key)) expiresAt.set(key, Date.now() - 1);
        },
        remove: async () => undefined,
        close: async () => undefined,
    };
}

async function redisAtRest(port: number): Promise<AtRest> {
    const client = createClient({ socket: { host: '127.0.0.1', port } });
    await client.connect();
    return {
        keys: async () => {
            const found: string[] = [];
            for await (const batch of client.scanIterator({ MATCH: 'public-tracking:access*', COUNT: 500 })) found.push(...([] as string[]).concat(batch));
            return found;
        },
        ttlSeconds: async (key) => {
            const ttl = await client.ttl(key);
            return ttl < 0 ? null : ttl;
        },
        expire: async (key) => {
            await client.pExpire(key, 1);
            await sleep(10);
        },
        remove: async (keys) => {
            if (keys.length > 0) await client.del(keys);
        },
        close: async () => {
            await client.quit();
        },
    };
}
