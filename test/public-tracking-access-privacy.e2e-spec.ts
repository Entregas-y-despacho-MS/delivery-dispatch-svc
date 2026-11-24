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
/** Samples per path in the timing test: the median of 10 is stable on a loaded machine. */
const SAMPLES = 10;
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
            const reals = await Promise.all(Array.from({ length: SAMPLES }, () => fixtures.create()));
            const unknowns = Array.from({ length: SAMPLES }, unknownCode);
            // Warm-up: the first bcrypt and the first query of each path are slower than the rest.
            await askCode(unknownCode());
            await verify(unknownCode(), '123456');

            mailDelayMs = 1_500;
            const realAsk: number[] = [];
            const unknownAsk: number[] = [];
            try {
                // The real per-IP limit (20 per minute) is emptied outside the measured calls: 10 samples need more requests.
                for (let i = 0; i < SAMPLES; i++) {
                    throttler.storage.clear();
                    const known = await timed(() => askCode(reals[i].trackingCode));
                    const other = await timed(() => askCode(unknowns[i]));
                    expect([known.res.status, other.res.status]).toEqual([200, 200]);
                    realAsk.push(known.ms);
                    unknownAsk.push(other.ms);
                }
                // The answer never waits for the mail: a code that exists is not told apart by a 1.5 s delay.
                expect(Math.max(...realAsk)).toBeLessThan(mailDelayMs);
            } finally {
                // Restored even when an assertion fails, so a slow mailer never leaks into the next tests.
                await access.whenIdle();
                mailDelayMs = 0;
            }

            // A wrong code: for a real code issued, for a decoy issued (the unknowns above) and for a code never asked for.
            const neverAsked = Array.from({ length: SAMPLES }, unknownCode);
            const realVerify: number[] = [];
            const decoyVerify: number[] = [];
            const nothingVerify: number[] = [];
            for (let i = 0; i < SAMPLES; i++) {
                throttler.storage.clear();
                const right = String(mails.find((mail) => mail.metadata?.dispatchId === reals[i].dispatchId)!.context!.code);
                realVerify.push((await timed(() => verify(reals[i].trackingCode, wrongOf(right)))).ms);
                decoyVerify.push((await timed(() => verify(unknowns[i], '123456'))).ms);
                nothingVerify.push((await timed(() => verify(neverAsked[i], '123456'))).ms);
            }

            // Each path does one bcrypt (≈ tens of ms); a path that skipped it would be several times faster. The 0.5 ratio
            // between medians leaves room for a slow or loaded machine (a real difference is a factor of 3 or more: the
            // bcrypt mutations measured ≈ 0.1-0.3) without letting a path that skips the bcrypt pass.
            const similar = (a: number[], b: number[]): void => {
                const [x, y] = [median(a), median(b)];
                expect(Math.min(x, y) / Math.max(x, y), `medians ${x.toFixed(1)} ms vs ${y.toFixed(1)} ms`).toBeGreaterThan(0.5);
            };
            similar(realAsk, unknownAsk);
            similar(realVerify, decoyVerify);
            similar(realVerify, nothingVerify);
        });
    });

    describe('limits', () => {
        it('counts the limits on the normalised code: case and spaces open the session but do not buy more tries', async () => {
            const { trackingCode } = await fixtures.create();
            const spellings = [trackingCode, trackingCode.toLowerCase(), `  ${trackingCode} `, ` ${trackingCode.toLowerCase()}`];

            // One request with one spelling is the cooldown of all of them.
            expect((await askCode(spellings[1])).status).toBe(200);
            await access.whenIdle();
            for (const spelling of spellings) expect((await askCode(spelling)).status).toBe(429);

            // The code mailed to the lowercase spelling opens the session with another spelling.
            const session = await verify(spellings[2], lastAccessCode());
            expect(session.status).toBe(200);
            touchedSessions.add(session.body.session);
            expect((await view(session.body.session)).body.trackingCode).toBe(trackingCode);

            // 1 verification done; 9 more spread over the spellings, and the 11th is refused whatever the spelling.
            for (let i = 0; i < 9; i++) expect((await verify(spellings[i % spellings.length], '123456')).status).toBe(400);
            for (const spelling of spellings) expect((await verify(spelling, '123456')).status).toBe(429);
        });

        it('never resets the 10 verifications of the window by asking for a new code', async () => {
            const { trackingCode, dispatchId } = await fixtures.create();

            const first = await codeFor(trackingCode);
            for (let i = 0; i < 5; i++) expect((await verify(trackingCode, wrongOf(first))).status).toBe(400);
            await endCooldown(trackingCode);
            const second = await codeFor(trackingCode);
            for (let i = 0; i < 5; i++) expect((await verify(trackingCode, wrongOf(second))).status).toBe(400);

            const right = await verify(trackingCode, second);
            expect(right.status).toBe(429);
            expect(right.body.error).toBe('TRACKING_ACCESS_RATE_LIMITED');
            await access.whenIdle();
            expect((await accessEvents(dispatchId)).map((event) => event.event_type)).not.toContain('tracking_access_verified');
        });

        it('sends one code when the same tracking code is requested many times at once', async () => {
            const { trackingCode } = await fixtures.create();
            const before = accessMails().length;

            // Every answer of the cache arrives 50 ms after it was read, so the requests overlap: a read followed by a write
            // would let all of them through; only an atomic "set if absent" lets one.
            const realGet = cache.get.bind(cache);
            const slowGet = vi.spyOn(cache, 'get').mockImplementation(async (key: string) => {
                const value = await realGet(key);
                await sleep(50);
                return value;
            });
            let results: Res[];
            try {
                results = await Promise.all(Array.from({ length: 6 }, () => askCode(trackingCode)));
                await access.whenIdle();
            } finally {
                slowGet.mockRestore();
            }

            expect(results.map((res) => res.status).sort()).toEqual([200, 429, 429, 429, 429, 429]);
            expect(accessMails().length).toBe(before + 1);
        });

        it(`limits one client IP to ${IP_LIMIT} tries a minute on each route, whatever the codes and the X-Forwarded-For it sends`, async () => {
            const real = await fixtures.create();
            const session = await sessionFor(real.trackingCode);
            throttler.storage.clear();
            const forged = (i: number): string => `203.0.113.${i + 1}`;

            for (let i = 0; i < IP_LIMIT; i++) expect((await askCode(unknownCode(), forged(i))).status).toBe(200);
            const askBlocked = [await askCode(unknownCode(), forged(99)), await askCode(real.trackingCode, forged(100))];

            for (let i = 0; i < IP_LIMIT; i++) expect((await verify(unknownCode(), '123456', forged(i))).status).toBe(400);
            const verifyBlocked = [await verify(unknownCode(), '123456', forged(99)), await verify(real.trackingCode, '123456', forged(100))];

            for (let i = 0; i < IP_LIMIT - 1; i++) expect((await view('f'.repeat(64)).set('X-Forwarded-For', forged(i))).status).toBe(401);
            expect((await view(session)).status).toBe(200);
            const viewBlocked = await view(session).set('X-Forwarded-For', forged(99));

            for (const res of [...askBlocked, ...verifyBlocked, viewBlocked]) {
                expect(res.status).toBe(429);
                expect(res.body.error).toBe('TOO_MANY_REQUESTS');
            }
            expect(comparable(askBlocked[1])).toEqual(comparable(askBlocked[0]));
            expect(comparable(verifyBlocked[1])).toEqual(comparable(verifyBlocked[0]));
            // The blocked request for the real code reached nothing: no code was mailed for it.
            await access.whenIdle();
            expect(accessMails().filter((mail) => mail.metadata?.dispatchId === real.dispatchId)).toHaveLength(1);
        });
    });

    describe('brute force', () => {
        it('does not open a dispatch with the code mailed for another one', async () => {
            const a = await fixtures.create();
            const b = await fixtures.create();
            const codeA = await codeFor(a.trackingCode);
            const codeB = await codeFor(b.trackingCode);

            const crossed = await verify(b.trackingCode, codeA);
            expect(crossed.status).toBe(codeA === codeB ? 200 : 400);
            if (codeA === codeB) return; // one chance in a million: the codes happen to be equal

            const own = await verify(b.trackingCode, codeB);
            expect(own.status).toBe(200);
            touchedSessions.add(own.body.session);
            expect((await view(own.body.session)).body.trackingCode).toBe(b.trackingCode);
            const ownA = await verify(a.trackingCode, codeA);
            expect(ownA.status).toBe(200);
            touchedSessions.add(ownA.body.session);
            // Each session reads only its own dispatch.
            expect((await view(ownA.body.session)).body.trackingCode).toBe(a.trackingCode);
            expect((await view(own.body.session)).body.trackingCode).toBe(b.trackingCode);

            // Another dispatch named in the query or in headers next to the session changes nothing: the session decides.
            const withForeignIds = await http()
                .get(`${base()}/access/view`)
                .query({ trackingCode: a.trackingCode, dispatchId: a.dispatchId })
                .set('X-Tracking-Session', own.body.session)
                .set('X-Tracking-Code', a.trackingCode)
                .set('X-Dispatch-Id', String(a.dispatchId));
            expect(withForeignIds.status).toBe(200);
            expect(withForeignIds.body).toEqual((await view(own.body.session)).body);
        });

        it('a code already used to open a session is refused the second time, like a wrong one', async () => {
            const { trackingCode } = await fixtures.create();
            const code = await codeFor(trackingCode);
            const first = await verify(trackingCode, code);
            expect(first.status).toBe(200);
            touchedSessions.add(first.body.session);

            const again = await verify(trackingCode, code);
            const wrong = await verify(trackingCode, wrongOf(code));
            expect(again.status).toBe(400);
            expect(again.body).toEqual({ ...wrong.body, timestamp: again.body.timestamp });
        });

        it('audits the burn of a code once, as the customer, with no secret, however many tries follow', async () => {
            const { trackingCode, dispatchId } = await fixtures.create();
            const right = await codeFor(trackingCode);

            for (let i = 0; i < 9; i++) expect((await verify(trackingCode, wrongOf(right))).status).toBe(400);
            await access.whenIdle();

            const locked = (await accessEvents(dispatchId)).filter((event) => event.event_type === 'tracking_access_locked');
            expect(locked).toHaveLength(1);
            expect(locked[0]).toMatchObject({ actor_type: 'customer', metadata: { maxAttempts: 5 } });
            expect(JSON.stringify(locked)).not.toMatch(new RegExp(`${right}|${trackingCode}|customer@example\\.test`));
            // The 10th verification of the window: the right code no longer exists.
            expect((await verify(trackingCode, right)).status).toBe(400);
        });

        it('does not accept a code whose email bounced or failed, and only a new code sent afterwards opens the session', async () => {
            for (const mode of ['bounced', 'throws'] as const) {
                const { trackingCode, dispatchId } = await fixtures.create();
                mailMode = mode;
                const asked = await askCode(trackingCode);
                expect(asked.body).toEqual({ accepted: true, expiresInSeconds: TTL });
                await access.whenIdle();
                const undelivered = lastAccessCode();
                mailMode = 'sent';

                const tried = await verify(trackingCode, undelivered);
                expect(tried.status).toBe(400);
                expect(tried.body.error).toBe('INVALID_ACCESS_CODE');
                expect((await accessEvents(dispatchId)).map((event) => event.event_type)).toEqual([]);

                await endCooldown(trackingCode);
                const fresh = await codeFor(trackingCode);
                const opened = await verify(trackingCode, fresh);
                expect(opened.status).toBe(200);
                touchedSessions.add(opened.body.session);
            }
        });

        it('rejects an expired code with the same 400 as an unknown tracking code', async () => {
            const { trackingCode, dispatchId } = await fixtures.create();
            const code = await codeFor(trackingCode);
            await atRest.expire(accessKey('code', trackingCode));

            const expired = await verify(trackingCode, code);
            const unknown = await verify(unknownCode(), code);
            expect(comparable(expired)).toMatchObject({ status: 400, error: 'INVALID_ACCESS_CODE' });
            expect(comparable(expired)).toEqual(comparable(unknown));
            expect((await accessEvents(dispatchId)).map((event) => event.event_type)).toEqual(['tracking_access_code_sent']);
        });

        it('stops the previous code from working once a new one is asked for', async () => {
            const { trackingCode } = await fixtures.create();
            const old = await codeFor(trackingCode);
            await endCooldown(trackingCode);
            const fresh = await codeFor(trackingCode);
            if (old === fresh) return; // one chance in a million

            expect((await verify(trackingCode, old)).status).toBe(400);
            const opened = await verify(trackingCode, fresh);
            expect(opened.status).toBe(200);
            touchedSessions.add(opened.body.session);
        });
    });

    describe('scope of the session', () => {
        it('rejects a revoked, an expired, a tampered or a misplaced session with the one 401 of an unknown session', async () => {
            const { trackingCode } = await fixtures.create();
            const unknown = await view('e'.repeat(64));
            expect(comparable(unknown)).toMatchObject({ status: 401, error: 'TRACKING_SESSION_INVALID' });
            const sameAsUnknown = (res: Res): void => expect(comparable(res)).toEqual(comparable(unknown));
            // A session put in the URL by the client is ignored; the error echoes the URL as it came (see the report).
            const ignored = (res: Res): void => expect({ ...comparable(res), path: '' }).toEqual({ ...comparable(unknown), path: '' });

            // Revoked: the cache let the key expire.
            const revoked = await sessionFor(trackingCode);
            expect((await view(revoked)).status).toBe(200);
            await atRest.expire(sessionKey(revoked));
            sameAsUnknown(await view(revoked));

            // Expired by its own record: the key is still in the cache, but the session ended a second ago.
            await endCooldown(trackingCode);
            const stale = await sessionFor(trackingCode);
            const record = JSON.parse((await cache.get(sessionKey(stale)))!) as { dispatchId: number; expiresAt: number };
            await cache.setWithTtl(sessionKey(stale), JSON.stringify({ ...record, expiresAt: Date.now() - 1_000 }), TTL);
            sameAsUnknown(await view(stale));

            await endCooldown(trackingCode);
            const live = await sessionFor(trackingCode);
            const flipped = live.slice(0, -1) + (live.endsWith('0') ? '1' : '0');
            for (const tampered of [flipped, live.toUpperCase(), `${live}0`, live.slice(1)]) sameAsUnknown(await view(tampered));
            // Never read from the URL nor from a bearer token.
            ignored(await http().get(`${base()}/access/view?session=${live}&x-tracking-session=${live}`));
            sameAsUnknown(await http().get(`${base()}/access/view`).set('Authorization', `Bearer ${live}`));
            sameAsUnknown(await http().get(`${base()}/access/view`).set('Cookie', `x-tracking-session=${live}`));
            expect((await view(live)).status).toBe(200);
        });

        it('cannot act on the dispatch nor read the full page of the link with a session', async () => {
            const { trackingCode, dispatchId } = await fixtures.create();
            const session = await sessionFor(trackingCode);
            const snapshot = async () => (await db.query(
                `SELECT d.customer_confirmation, d.version, d.scheduled_window_start, d.tracking_token,
                        (SELECT COUNT(*)::int FROM dispatch_events e WHERE e.dispatch_id = d.dispatch_id) AS events
                   FROM dispatches d WHERE d.dispatch_id = $1`,
                [dispatchId],
            ))[0];
            const before = await snapshot();

            const attempts: [string, request.Test][] = [
                ['GET page', http().get(`${base()}/${session}`)],
                ['POST confirm', http().post(`${base()}/${session}/confirm`).set('X-Tracking-Session', session)],
                ['POST verification-code', http().post(`${base()}/${session}/verification-code`).set('X-Tracking-Session', session)],
                // Valid bodies, so the request reaches the link check instead of failing on validation.
                ['POST reschedule', http().post(`${base()}/${session}/reschedule`).set('X-Tracking-Session', session).send({ slotId: '1767225600.1' })],
                ['POST change-request', http().post(`${base()}/${session}/change-request`).set('X-Tracking-Session', session).send({ detail: 'Necesito la entrega otro día.' })],
                ['POST rating', http().post(`${base()}/${session}/rating`).set('X-Tracking-Session', session).send({ score: 5 })],
                ['GET slots', http().get(`${base()}/${session}/slots`).set('X-Tracking-Session', session)],
            ];
            // A session is not a link token: every route of the link answers 404 TRACKING_LINK_NOT_FOUND, the same as an
            // unknown token, and never a validation error that would stop before the check.
            const answers = await Promise.all(attempts.map(async ([label, req]) => {
                const res = await req;
                return [label, res.status, res.body.error];
            }));
            expect(answers).toEqual(attempts.map(([label]) => [label, 404, 'TRACKING_LINK_NOT_FOUND']));
            await access.whenIdle();
            expect(await snapshot()).toEqual(before);
        });

        it('keeps the reschedule link and the access by code apart: neither code opens the other flow, and the link is untouched', async () => {
            const { trackingCode, token, dispatchId } = await fixtures.create();
            // The keys of the link's own rescheduling code, by dispatch.
            for (const kind of ['code', 'attempts', 'sends', 'proof']) otherKeys.add(`public-tracking:${kind}:${dispatchId}`);
            const [{ tracking_token: tokenBefore }] = await db.query(`SELECT tracking_token FROM dispatches WHERE dispatch_id = $1`, [dispatchId]);

            // The rescheduling code of the link does not open a session.
            const sent = await http().post(`${base()}/${token}/verification-code`);
            expect(sent.status).toBe(200);
            await access.whenIdle();
            const linkMail = mails.at(-1)!;
            expect(linkMail.template).not.toBe(ACCESS_TEMPLATE);
            const linkCode = String(linkMail.context!.code);
            expect((await verify(trackingCode, linkCode)).status).toBe(400);

            // The access code does not pass the link's verification.
            const accessCode = await codeFor(trackingCode);
            if (accessCode !== linkCode) {
                const crossed = await http().post(`${base()}/${token}/verification-code/verify`).send({ code: accessCode });
                expect(crossed.status).toBe(400);
                expect(crossed.body.proof).toBeUndefined();
            }

            // Each code still works in its own flow, and the session left the link as it was.
            const proof = await http().post(`${base()}/${token}/verification-code/verify`).send({ code: linkCode });
            expect(proof.status).toBe(200);
            const opened = await verify(trackingCode, accessCode);
            expect(opened.status).toBe(200);
            touchedSessions.add(opened.body.session);
            const page = await http().get(`${base()}/${token}`);
            expect(page.status).toBe(200);
            expect(page.body.selfService).toBeDefined();
            const [{ tracking_token: tokenAfter }] = await db.query(`SELECT tracking_token FROM dispatches WHERE dispatch_id = $1`, [dispatchId]);
            expect(tokenAfter).toBe(tokenBefore);
        });
    });

    describe('privacy', () => {
        it('shows the driver and the position of a delivery in transit, but nothing to reach the customer or the driver', async () => {
            const [warehouse] = await fixtures.warehouses();
            const zoneId = await fixtures.createZone('P');
            const vehicleId = await fixtures.createVehicle();
            const [{ user_id }] = await db.query(
                `INSERT INTO users (role_id, full_name, username, email, password_hash, requires_pwd_change)
                 VALUES ((SELECT role_id FROM roles WHERE name = 'driver'), 'Repartidor Privado', $1, $2, 'not-a-hash', FALSE) RETURNING user_id`,
                [`e2e_accpriv_${run}`.toLowerCase().slice(0, 50), `driver.${run}@example.test`.toLowerCase()],
            );
            driverUserId = Number(user_id);
            const routeBatchId = await fixtures.createBatch({ shiftDate: '2026-10-20', vehicleId, zoneId, warehouseId: warehouse.id });
            await db.query(`UPDATE route_batches SET driver_id = $2 WHERE route_batch_id = $1`, [routeBatchId, driverUserId]);
            const email = `client.${run}@example.test`.toLowerCase();
            const dispatch = await fixtures.create({ status: 'in_transit', routeBatchId, zoneId, warehouseId: warehouse.id, email });
            await db.query(
                `UPDATE dispatches SET last_latitude = -16.5, last_longitude = -68.15, last_location_at = NOW() WHERE dispatch_id = $1`,
                [dispatch.dispatchId],
            );

            otherKeys.add(`tracking:eta:${dispatch.dispatchId}`); // the page of a delivery on its way caches its ETA
            const session = await sessionFor(dispatch.trackingCode);
            const page = await view(session);

            expect(page.status).toBe(200);
            expect(Object.keys(page.body).sort()).toEqual(['deliveryDate', 'driver', 'eta', 'location', 'status', 'trackingCode', 'windowEnd', 'windowStart']);
            expect(page.body.status).toBe('in_transit');
            expect(page.body.driver).toEqual({ name: 'Repartidor Privado', vehicleType: 'camioneta', vehiclePlate: expect.any(String) });
            expect(Object.keys(page.body.location).sort()).toEqual(['latitude', 'longitude', 'recordedAt']);
            const shown = JSON.stringify(page.body);
            for (const secret of [
                email, `driver.${run}`.toLowerCase(), `e2e_accpriv_${run}`.toLowerCase(), 'Calle Secreta', '70000000', 'E2E customer',
                dispatch.token, dispatch.ref, session, `"dispatchId"`, `"routeBatchId"`, 'otp', 'selfService', 'rating',
            ]) expect(shown).not.toContain(secret);
        });

        it('keeps nothing in clear in the cache: fingerprints as keys, a bcrypt hash of the code, a session record of dispatch and expiry', async () => {
            const { trackingCode, dispatchId, token } = await fixtures.create();
            const unknown = unknownCode();
            const code = await codeFor(trackingCode);
            expect((await askCode(unknown)).status).toBe(200);
            expect((await verify(trackingCode, wrongOf(code))).status).toBe(400);
            await access.whenIdle();

            // Before the session: the code record of a real dispatch and the decoy of an unknown code look alike.
            const real = JSON.parse((await cache.get(accessKey('code', trackingCode)))!) as Record<string, unknown>;
            const decoy = JSON.parse((await cache.get(accessKey('code', unknown)))!) as Record<string, unknown>;
            expect(real).toEqual({ hash: expect.stringMatching(/^\$2[aby]\$10\$/), dispatchId });
            expect(decoy).toEqual({ hash: expect.stringMatching(/^\$2[aby]\$10\$/), dispatchId: null });
            const around = (seconds: number | null, expected: number): void => {
                expect(seconds).not.toBeNull();
                expect(seconds!).toBeGreaterThan(expected - 30);
                expect(seconds!).toBeLessThanOrEqual(expected);
            };
            for (const asked of [trackingCode, unknown]) {
                around(await atRest.ttlSeconds(accessKey('code', asked)), TTL);
                around(await atRest.ttlSeconds(accessKey('sends', asked)), 15 * 60);
                around(await atRest.ttlSeconds(accessKey('cooldown', asked)), 60);
            }
            around(await atRest.ttlSeconds(accessKey('verifies', trackingCode)), 15 * 60);

            const opened = await verify(trackingCode, code);
            expect(opened.status).toBe(200);
            const session: string = opened.body.session;
            touchedSessions.add(session);
            expect(await cache.get(accessKey('code', trackingCode))).toBeNull();
            const stored = JSON.parse((await cache.get(sessionKey(session)))!) as Record<string, unknown>;
            expect(stored).toEqual({ dispatchId, expiresAt: new Date(opened.body.expiresAt).getTime() });
            around(await atRest.ttlSeconds(sessionKey(session)), TTL);

            const keys = await atRest.keys();
            expect(keys).toContain(sessionKey(session));
            const everything = JSON.stringify(await Promise.all(keys.map(async (key) => [key, await cache.get(key)])));
            for (const secret of [trackingCode, trackingCode.toLowerCase(), unknown, session, token, 'customer@example.test', `"${code}"`, `:${code}`]) {
                expect(everything).not.toContain(secret);
            }
        });

        it('writes no code, session, tracking code, link token or email to the logs, the events, the notifications, the outbox or the audit', async () => {
            const email = `trail.${run}@example.test`.toLowerCase();
            const failing = await fixtures.create({ email: `fail.${run}@example.test`.toLowerCase() });
            const dispatch = await fixtures.create({ email });
            const logsBefore = logs.length;

            // An SMTP error that carries the address, a session opened, a burn and both limits.
            mailMode = 'throws';
            await askCode(failing.trackingCode);
            await access.whenIdle();
            const failedCode = lastAccessCode();
            mailMode = 'sent';
            const code = await codeFor(dispatch.trackingCode);
            const opened = await verify(dispatch.trackingCode, code);
            const session: string = opened.body.session;
            touchedSessions.add(session);
            expect((await view(session)).status).toBe(200);
            await endCooldown(dispatch.trackingCode);
            const burned = await codeFor(dispatch.trackingCode);
            for (let i = 0; i < 6; i++) await verify(dispatch.trackingCode, wrongOf(burned));
            for (let i = 0; i < 4; i++) await verify(dispatch.trackingCode, '123456');
            expect((await askCode(dispatch.trackingCode)).status).toBe(429);
            await access.whenIdle();

            // The spy really saw the app's lines: the failed email and the limits.
            const written = logs.slice(logsBefore).join('\n');
            expect(written).toContain(`dispatch ${failing.dispatchId} was not sent`);
            expect(written).toContain('A tracking access limit was reached.');
            const clearSecrets = [
                session, failing.trackingCode, dispatch.trackingCode, failing.token, dispatch.token, email, `fail.${run}`.toLowerCase(),
                sha256(session), // not even the fingerprint of the session
            ];
            for (const secret of [...clearSecrets, failedCode, code, burned]) expect(written).not.toContain(secret);

            // Events of both dispatches: the code can only be looked for where free text lives (not in timestamps).
            const events = await db.query(
                `SELECT event_type, actor_type, reason, detail, metadata FROM dispatch_events WHERE dispatch_id = ANY($1::int[])`,
                [[failing.dispatchId, dispatch.dispatchId]],
            );
            expect(events.map((event: { event_type: string }) => event.event_type).sort())
                .toEqual(['tracking_access_code_sent', 'tracking_access_code_sent', 'tracking_access_locked', 'tracking_access_verified']);
            const eventText = JSON.stringify(events);
            for (const secret of [...clearSecrets, failedCode, code, burned]) expect(eventText).not.toContain(secret);

            // Every row any table of the trail got during this suite.
            for (const table of ['dispatch_events', 'customer_notifications', 'outbound_messages', 'audit_logs', 'admin_audit_events']) {
                const [{ n }] = await db.query(
                    `SELECT COUNT(*)::int AS n FROM ${table} t WHERE t.created_at >= $1 AND row_to_json(t)::text LIKE ANY($2::text[])`,
                    [startedAt, clearSecrets.map((secret) => `%${secret}%`)],
                );
                expect(n, table).toBe(0);
            }
            const [{ n: notices }] = await db.query(
                `SELECT COUNT(*)::int AS n FROM customer_notifications WHERE dispatch_id = ANY($1::int[])`,
                [[failing.dispatchId, dispatch.dispatchId]],
            );
            expect(notices).toBe(0);

            // The mailed code only travels in the body of the email, never in its subject nor in a link.
            const mail = accessMails().at(-1)!;
            expect(mail.to).toBe(email);
            expect(mail.subject).not.toContain(burned);
            expect(JSON.stringify(mail.metadata)).toBe(JSON.stringify({ dispatchId: dispatch.dispatchId }));
        });
    });
});

/**
 * The in-memory adapter keeps two maps; the suite reads them to see what is stored and for how long. It depends on the
 * private fields `values` and `expiresAt` of that adapter: if they are renamed, this throws a clear error instead of
 * passing without checking anything.
 */
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
