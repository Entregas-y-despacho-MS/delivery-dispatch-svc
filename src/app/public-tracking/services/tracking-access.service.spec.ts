import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCacheAdapter } from '../../../plugins/cache/memory/memory-cache.adapter.js';
import { CacheUnavailableException } from '../../../plugins/cache/exceptions/index.js';
import { accessKey, trackingCodeFingerprint } from '../domain/tracking-access.js';
import { TrackingAccessService } from './tracking-access.service.js';

const MIN = 60_000;
const CODE = 'DSP-2026-00001';

interface Sent { to: string; template: string; context: { code: string; expiresInMinutes: number } }

function setup(options: { known?: boolean; mailStatus?: 'sent' | 'failed'; mailThrows?: boolean; cache?: any } = {}) {
    const cache = options.cache ?? new MemoryCacheAdapter();
    const sent: Sent[] = [];
    const mailer = {
        send: vi.fn(async (mail: any) => {
            if (options.mailThrows) throw new Error('smtp down');
            sent.push(mail);
            return { status: options.mailStatus ?? 'sent' };
        }),
    };
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM dispatches')) return options.known === false || params?.[0] !== CODE ? [] : [{ dispatch_id: 7, contact_email: 'customer@example.test' }];
        return [];
    });
    const tracking = { sessionView: vi.fn(async (dispatchId: number) => ({ trackingCode: CODE, status: 'scheduled', dispatchId })) };
    const settings = { getNumber: vi.fn(async () => 10) };
    const service = new TrackingAccessService({ query } as any, cache, mailer as any, settings as any, tracking as any);
    const lastCode = () => sent.at(-1)!.context.code;
    const events = () => query.mock.calls.filter((call) => String(call[0]).includes('dispatch_events')).map((call) => call[1] as unknown[]);
    return { service, cache, mailer, sent, lastCode, events, query, tracking };
}

const wrongOf = (code: string) => (code === '000000' ? '111111' : '000000');

/** Asks for a code and waits for the background email. */
async function ask(env: ReturnType<typeof setup>, code = CODE, now?: Date) {
    const answer = await env.service.requestCode(code, now);
    await env.service.whenIdle();
    return answer;
}

describe('TrackingAccessService', () => {
    afterEach(() => vi.useRealTimers());

    describe('requestCode', () => {
        it('mails a 6-digit code to the registered email of the dispatch', async () => {
            const env = setup();
            await ask(env);

            expect(env.sent).toHaveLength(1);
            expect(env.sent[0]).toMatchObject({ to: 'customer@example.test', template: 'tracking-access-code' });
            expect(env.sent[0].context.code).toMatch(/^\d{6}$/);
            expect(env.sent[0].context.expiresInMinutes).toBe(10);
        });

        it('answers the same for a known and an unknown tracking code, and mails nobody for the unknown one', async () => {
            const known = setup();
            const unknown = setup({ known: false });

            const a = await ask(known);
            const b = await ask(unknown);

            expect(a).toEqual({ accepted: true, expiresInSeconds: 600 });
            expect(b).toEqual(a);
            expect(known.sent).toHaveLength(1);
            expect(unknown.sent).toHaveLength(0);
        });

        it('stores a decoy for an unknown code that belongs to no dispatch, so it can never open a session', async () => {
            const env = setup({ known: false });
            await ask(env);

            const decoy = JSON.parse((await env.cache.get(accessKey('code', trackingCodeFingerprint(CODE))))!);
            expect(decoy.dispatchId).toBeNull();
            expect(decoy.hash).toMatch(/^\$2[aby]\$/);
            expect(env.sent).toHaveLength(0);
        });

        it('treats a malformed code like an unknown one without reading the database', async () => {
            const env = setup();

            await expect(ask(env, 'not a code; DROP TABLE')).resolves.toEqual({ accepted: true, expiresInSeconds: 600 });
            expect(env.query).not.toHaveBeenCalled();
            expect(env.sent).toHaveLength(0);
        });

        it('normalises the code, so lower case and spaces are the same code', async () => {
            const env = setup();
            await ask(env, '  dsp-2026-00001 ');
            expect(env.sent).toHaveLength(1);
        });

        it('stores only a hash, and the audit event says nothing secret', async () => {
            const env = setup();
            await ask(env);

            const stored = (await env.cache.get(accessKey('code', trackingCodeFingerprint(CODE))))!;
            expect(stored).not.toContain(env.lastCode());
            expect(JSON.parse(stored).hash).toMatch(/^\$2[aby]\$/);
            const [event] = env.events();
            expect(event.slice(0, 2)).toEqual([7, 'tracking_access_code_sent']);
            expect(JSON.stringify(event)).not.toContain(env.lastCode());
            expect(JSON.stringify(event)).not.toContain('customer@example.test');
            expect(JSON.stringify(event)).not.toContain(CODE);
        });

        it('imposes a cooldown between two requests for the same tracking code, known or not', async () => {
            for (const known of [true, false]) {
                const env = setup({ known });
                await ask(env);
                await expect(env.service.requestCode(CODE)).rejects.toMatchObject({ status: 429, response: { error: 'TRACKING_ACCESS_RATE_LIMITED' } });
            }
        });

        it('refuses a fourth code in the window, with the same answer for an unknown code', async () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            for (const known of [true, false]) {
                const env = setup({ known });
                for (let i = 0; i < 3; i++) {
                    await ask(env);
                    vi.setSystemTime(new Date(Date.now() + 2 * MIN));
                }
                await expect(env.service.requestCode(CODE)).rejects.toMatchObject({ status: 429, response: { error: 'TRACKING_ACCESS_RATE_LIMITED' } });
            }
        });

        it('does not tell the caller when the email could not be sent, and leaves no usable code', async () => {
            vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            const env = setup({ mailStatus: 'failed' });

            await expect(ask(env)).resolves.toEqual({ accepted: true, expiresInSeconds: 600 });
            await expect(env.service.verify(CODE, '123456')).rejects.toMatchObject({ response: { error: 'INVALID_ACCESS_CODE' } });
        });

        it('does not tell either when the mailer throws', async () => {
            vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            const env = setup({ mailThrows: true });
            await expect(ask(env)).resolves.toEqual({ accepted: true, expiresInSeconds: 600 });
        });

        it('turns a cache that is down into 503', async () => {
            const cache = new MemoryCacheAdapter();
            vi.spyOn(cache, 'setIfAbsent').mockRejectedValue(new CacheUnavailableException());
            const env = setup({ cache });
            await expect(env.service.requestCode(CODE)).rejects.toMatchObject({ status: 503, response: { error: 'VERIFICATION_UNAVAILABLE' } });
        });
    });

    describe('verify', () => {
        it('opens a session limited to the dispatch, which is consumed once', async () => {
            const env = setup();
            await ask(env);
            const now = new Date('2026-11-24T10:00:00Z');

            const result = await env.service.verify(CODE, env.lastCode(), now);

            expect(result.session).toMatch(/^[0-9a-f]{64}$/);
            expect(result.expiresAt).toEqual(new Date(now.getTime() + 10 * MIN));
            await expect(env.service.verify(CODE, env.lastCode(), now)).rejects.toMatchObject({ response: { error: 'INVALID_ACCESS_CODE' } });
            expect(env.events().map((e) => e[1])).toEqual(['tracking_access_code_sent', 'tracking_access_verified']);
        });

        it('does not store the session in clear nor put it in the audit event', async () => {
            const env = setup();
            await ask(env);
            const { session } = await env.service.verify(CODE, env.lastCode());

            for (const event of env.events()) expect(JSON.stringify(event)).not.toContain(session);
            await expect(env.cache.get(`public-tracking:access-session:${session}`)).resolves.toBeNull();
        });

        it('answers the same generic error for a wrong code, an unknown tracking code and no code at all', async () => {
            const known = setup();
            const unknown = setup({ known: false });
            await ask(known);
            await ask(unknown);

            const errors = [
                await known.service.verify(CODE, wrongOf(known.lastCode())).catch((e) => e),
                await unknown.service.verify(CODE, '123456').catch((e) => e),
                await setup().service.verify(CODE, '123456').catch((e) => e),
            ];
            for (const error of errors) {
                expect(error.status).toBe(400);
                expect(error.response).toEqual(errors[0].response);
            }
            expect(errors[0].response.error).toBe('INVALID_ACCESS_CODE');
        });

        it('burns the code after 5 wrong guesses: even the right code then fails', async () => {
            vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            const env = setup();
            await ask(env);
            const right = env.lastCode();

            for (let i = 0; i < 5; i++) await expect(env.service.verify(CODE, wrongOf(right))).rejects.toMatchObject({ response: { error: 'INVALID_ACCESS_CODE' } });
            await expect(env.service.verify(CODE, right)).rejects.toMatchObject({ response: { error: 'INVALID_ACCESS_CODE' } });
            await expect(env.service.verify(CODE, right)).rejects.toMatchObject({ response: { error: 'INVALID_ACCESS_CODE' } });
            await env.service.whenIdle();
            expect(env.events().map((e) => e[1])).toContain('tracking_access_locked');
        });

        it('caps the tries per tracking code in a window even if codes are requested again', async () => {
            vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            const env = setup();
            await ask(env);
            for (let i = 0; i < 10; i++) await env.service.verify(CODE, wrongOf(env.lastCode())).catch(() => undefined);

            await expect(env.service.verify(CODE, env.lastCode())).rejects.toMatchObject({ status: 429, response: { error: 'TRACKING_ACCESS_RATE_LIMITED' } });
        });

        it('limits an unknown tracking code exactly like a known one', async () => {
            vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            const unknown = setup({ known: false });
            for (let i = 0; i < 10; i++) await unknown.service.verify(CODE, '123456').catch(() => undefined);
            await expect(unknown.service.verify(CODE, '123456')).rejects.toMatchObject({ status: 429 });
        });

        it('rejects a code that expired', async () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            const cache = new MemoryCacheAdapter();
            const env = setup({ cache });
            await ask(env);
            vi.setSystemTime(new Date(Date.now() + 11 * MIN));

            await expect(env.service.verify(CODE, env.lastCode())).rejects.toMatchObject({ response: { error: 'INVALID_ACCESS_CODE' } });
        });

        it('lets only one of two parallel verifications with the right code get a session', async () => {
            const env = setup();
            await ask(env);

            const results = await Promise.allSettled([env.service.verify(CODE, env.lastCode()), env.service.verify(CODE, env.lastCode())]);

            expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        });

        it('never logs the code, the tracking code or the email', async () => {
            const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            const env = setup({ mailStatus: 'failed' });
            await ask(env);
            for (let i = 0; i < 12; i++) await env.service.verify(CODE, '123456').catch(() => undefined);

            const logged = JSON.stringify(warn.mock.calls);
            expect(logged).not.toContain(CODE);
            expect(logged).not.toContain('customer@example.test');
        });
    });

    describe('view', () => {
        it('shows the dispatch of the session, taken from the cache and not from the request', async () => {
            const env = setup();
            await ask(env);
            const { session } = await env.service.verify(CODE, env.lastCode());

            await expect(env.service.view(session)).resolves.toMatchObject({ dispatchId: 7 });
            expect(env.tracking.sessionView).toHaveBeenCalledWith(7, expect.any(Date));
        });

        it.each([undefined, '', CODE, 'a'.repeat(63), 'g'.repeat(64), 'a'.repeat(64)])('rejects %j with the same 401', async (session) => {
            const env = setup();
            await expect(env.service.view(session)).rejects.toMatchObject({ status: 401, response: { error: 'TRACKING_SESSION_INVALID' } });
            expect(env.tracking.sessionView).not.toHaveBeenCalled();
        });

        it('rejects the tracking code and the one-time code used as a session', async () => {
            const env = setup();
            await ask(env);
            await expect(env.service.view(env.lastCode())).rejects.toMatchObject({ status: 401 });
        });

        it('rejects an expired session', async () => {
            const env = setup();
            await ask(env);
            const { session } = await env.service.verify(CODE, env.lastCode(), new Date('2026-11-24T10:00:00Z'));

            await expect(env.service.view(session, new Date('2026-11-24T10:10:01Z'))).rejects.toMatchObject({ status: 401 });
        });
    });
});
