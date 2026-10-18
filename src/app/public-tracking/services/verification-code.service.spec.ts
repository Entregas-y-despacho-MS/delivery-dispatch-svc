import { Logger } from '@nestjs/common';
import { hashToken } from '../../../shared/utils/crypto.util.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCacheAdapter } from '../../../plugins/cache/memory/memory-cache.adapter.js';
import { CacheUnavailableException } from '../../../plugins/cache/exceptions/index.js';
import type { TrackingContext } from './public-tracking.service.js';
import { VerificationCodeService } from './verification-code.service.js';

const MIN = 60_000;

function context(overrides: { canReschedule?: boolean; closedReason?: string | null; email?: string | null } = {}): TrackingContext {
    const email = overrides.email === undefined ? 'customer@example.test' : overrides.email;
    return {
        dispatchId: 7,
        status: 'scheduled',
        version: 1,
        row: { contact_email: email, has_contact_email: email !== null } as any,
        selfService: {
            open: true,
            closedReason: (overrides.closedReason ?? null) as any,
            windowClosesAt: new Date(),
            rescheduleAttemptsLeft: 2,
            canConfirm: true,
            canReschedule: overrides.canReschedule ?? true,
            canRequestChange: true,
        },
    };
}

function setup(options: { mailStatus?: 'sent' | 'bounced' | 'failed'; mailThrows?: boolean; cache?: any } = {}) {
    const cache = options.cache ?? new MemoryCacheAdapter();
    const sent: { to: string; template: string; context: { code: string; expiresInMinutes: number } }[] = [];
    const mailer = {
        send: vi.fn(async (mail: any) => {
            if (options.mailThrows) throw new Error('smtp down');
            sent.push(mail);
            return { status: options.mailStatus ?? 'sent' };
        }),
    };
    const settings = { getNumber: vi.fn(async () => 10) };
    const query = vi.fn(async (..._args: unknown[]) => []);
    const service = new VerificationCodeService({ query } as any, cache, mailer as any, settings as any);
    const lastCode = () => sent.at(-1)!.context.code;
    const events = () => query.mock.calls.map((call) => ({ sql: String(call[0]), params: call[1] as unknown[] }));
    return { service, cache, mailer, sent, lastCode, events, query };
}

const wrongOf = (code: string) => (code === '000000' ? '111111' : '000000');

describe('VerificationCodeService', () => {
    afterEach(() => vi.useRealTimers());

    describe('send', () => {
        it('mails a 6-digit code to the registered email and answers a partly hidden address', async () => {
            const { service, mailer, sent } = setup();
            const now = new Date('2026-10-17T14:00:00Z');

            const result = await service.send(context(), now);

            expect(result).toEqual({ sentTo: 'c***@example.test', expiresAt: new Date(now.getTime() + 10 * MIN) });
            expect(sent).toHaveLength(1);
            expect(sent[0]).toMatchObject({ to: 'customer@example.test', template: 'reschedule-code' });
            expect(sent[0].context.code).toMatch(/^\d{6}$/);
            expect(sent[0].context.expiresInMinutes).toBe(10);
            expect(mailer.send).toHaveBeenCalledTimes(1);
        });

        it('stores only a hash of the code, and the audit event says nothing secret', async () => {
            const { service, cache, lastCode, events } = setup();

            await service.send(context());

            const stored = (await cache.get('public-tracking:code:7'))!;
            expect(stored).not.toContain(lastCode());
            expect(JSON.parse(stored).hash).toMatch(/^\$2[aby]\$/);
            const [event] = events();
            expect(event.sql).toContain('dispatch_events');
            expect(event.params.slice(0, 2)).toEqual([7, 'reschedule_code_sent']);
            expect(JSON.stringify(event.params)).not.toContain(lastCode());
            expect(JSON.stringify(event.params)).not.toContain('customer@example.test');
        });

        it('refuses a fourth code inside the window', async () => {
            const { service, mailer } = setup();
            for (let i = 0; i < 3; i++) await service.send(context());

            await expect(service.send(context())).rejects.toMatchObject({ response: { error: 'VERIFICATION_CODE_RATE_LIMITED' }, status: 429 });
            expect(mailer.send).toHaveBeenCalledTimes(3);
        });

        it('asks again after the window', async () => {
            vi.useFakeTimers();
            const { service } = setup();
            for (let i = 0; i < 3; i++) await service.send(context());
            vi.advanceTimersByTime(15 * MIN);

            await expect(service.send(context())).resolves.toBeDefined();
        });

        it.each([
            ['bounced', { mailStatus: 'bounced' as const }],
            ['failed', { mailStatus: 'failed' as const }],
            ['thrown', { mailThrows: true }],
        ])('is a 503 and leaves no usable code when the email is %s', async (_name, options) => {
            const { service, cache, events } = setup(options);

            await expect(service.send(context())).rejects.toMatchObject({ response: { error: 'VERIFICATION_CODE_NOT_SENT' }, status: 503 });
            await expect(cache.get('public-tracking:code:7')).resolves.toBeNull();
            expect(events()).toHaveLength(0);
        });

        it.each([
            ['the window elapsed', { canReschedule: false, closedReason: 'window_elapsed' }, 'window_elapsed'],
            ['the attempts are used up', { canReschedule: false, closedReason: 'max_attempts' }, 'max_attempts'],
            ['there is no email', { canReschedule: false, email: null }, 'no_contact_email'],
            ['the rescheduling is not configured', { canReschedule: false }, 'not_configured'],
        ])('is a 409 with its reason when %s, and sends nothing', async (_name, overrides, reason) => {
            const { service, mailer } = setup();

            await expect(service.send(context(overrides))).rejects.toMatchObject({
                status: 409, response: { error: 'RESCHEDULE_NOT_AVAILABLE', details: { reason } },
            });
            expect(mailer.send).not.toHaveBeenCalled();
        });

        it('logs why the email failed, without the address, the code or the token', async () => {
            const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            const { service } = setup({ mailThrows: true });

            await expect(service.send(context())).rejects.toBeDefined();

            expect(warn).toHaveBeenCalledTimes(1);
            const line = String(warn.mock.calls[0][0]);
            expect(line).toContain('dispatch 7');
            expect(line).not.toContain('customer@example.test');
            expect(line).not.toMatch(/\d{6}/);
            warn.mockRestore();
        });

        it('turns a cache that is down into a 503 instead of a 500', async () => {
            const down = { increment: vi.fn(async () => { throw new CacheUnavailableException(); }) };
            const { service } = setup({ cache: down });

            await expect(service.send(context())).rejects.toMatchObject({ status: 503, response: { error: 'VERIFICATION_UNAVAILABLE' } });
        });
    });

    describe('verify', () => {
        it('trades the right code for a one-time proof that is valid for this dispatch only', async () => {
            const { service, lastCode, events } = setup();
            await service.send(context());
            const now = new Date('2026-10-17T14:05:00Z');

            const { proof, expiresAt } = await service.verify(context(), lastCode(), now);

            expect(proof).toMatch(/^[0-9a-f]{64}$/);
            expect(expiresAt).toEqual(new Date(now.getTime() + 10 * MIN));
            await expect(service.hasValidProof(7, proof, now)).resolves.toBe(true);
            await expect(service.hasValidProof(8, proof, now)).resolves.toBe(false);
            expect(events().map((e) => e.params[1])).toEqual(['reschedule_code_sent', 'reschedule_code_verified']);
            expect(JSON.stringify(events().at(-1)!.params)).not.toContain(proof);
        });

        it('never keeps the proof in clear', async () => {
            const { service, cache, lastCode } = setup();
            await service.send(context());

            const { proof } = await service.verify(context(), lastCode());

            expect(await cache.get('public-tracking:proof:7')).not.toContain(proof);
        });

        it('uses the code once: the same code a second time finds nothing', async () => {
            const { service, lastCode } = setup();
            await service.send(context());
            const code = lastCode();
            await service.verify(context(), code);

            await expect(service.verify(context(), code)).rejects.toMatchObject({ response: { error: 'VERIFICATION_CODE_EXPIRED' } });
        });

        it('counts down the attempts on a wrong code', async () => {
            const { service, lastCode } = setup();
            await service.send(context());
            const wrong = wrongOf(lastCode());

            for (const left of [4, 3, 2, 1, 0]) {
                await expect(service.verify(context(), wrong)).rejects.toMatchObject({
                    status: 400, response: { error: 'INVALID_VERIFICATION_CODE', details: { attemptsLeft: left } },
                });
            }
        });

        it('burns the code on the sixth try even with the right one, and records it', async () => {
            const { service, lastCode, events } = setup();
            await service.send(context());
            const right = lastCode();
            for (let i = 0; i < 5; i++) await expect(service.verify(context(), wrongOf(right))).rejects.toBeDefined();

            await expect(service.verify(context(), right)).rejects.toMatchObject({ response: { error: 'VERIFICATION_CODE_EXPIRED' } });
            await expect(service.verify(context(), right)).rejects.toMatchObject({ response: { error: 'VERIFICATION_CODE_EXPIRED' } });
            expect(events().some((e) => e.params[1] === 'reschedule_code_locked')).toBe(true);
        });

        it('lets a burst of parallel guesses reach the comparison only as many times as attempts exist', async () => {
            const { service, lastCode } = setup();
            await service.send(context());
            const wrong = wrongOf(lastCode());

            const results = await Promise.allSettled(Array.from({ length: 20 }, () => service.verify(context(), wrong)));

            const invalid = results.filter((r) => r.status === 'rejected' && (r.reason as any).response.error === 'INVALID_VERIFICATION_CODE');
            expect(invalid).toHaveLength(5);
        });

        it('gives a fresh set of attempts with a new code, which replaces the old one', async () => {
            const { service, sent } = setup();
            await service.send(context());
            const first = sent[0].context.code;
            for (let i = 0; i < 3; i++) await expect(service.verify(context(), wrongOf(first))).rejects.toBeDefined();

            await service.send(context());
            const second = sent[1].context.code;

            await expect(service.verify(context(), wrongOf(second))).rejects.toMatchObject({ response: { details: { attemptsLeft: 4 } } });
            if (first !== second) {
                await expect(service.verify(context(), first)).rejects.toMatchObject({ response: { error: 'INVALID_VERIFICATION_CODE' } });
            }
            await expect(service.verify(context(), second)).resolves.toMatchObject({ proof: expect.any(String) });
        });

        it('hands the proof to only one of two parallel requests with the right code', async () => {
            const { service, lastCode } = setup();
            await service.send(context());
            const code = lastCode();

            const results = await Promise.allSettled([service.verify(context(), code), service.verify(context(), code)]);

            expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        });

        it('expires the code and the proof after reschedule_code_expiry_minutes', async () => {
            vi.useFakeTimers();
            const { service, lastCode } = setup();
            await service.send(context());
            const code = lastCode();
            vi.advanceTimersByTime(10 * MIN);
            await expect(service.verify(context(), code)).rejects.toMatchObject({ response: { error: 'VERIFICATION_CODE_EXPIRED' } });

            await service.send(context());
            const { proof } = await service.verify(context(), lastCode());
            vi.advanceTimersByTime(10 * MIN - 1);
            await expect(service.hasValidProof(7, proof)).resolves.toBe(true);
            vi.advanceTimersByTime(1);
            await expect(service.hasValidProof(7, proof)).resolves.toBe(false);
        });

        it('says there is no code when none was requested', async () => {
            const { service } = setup();

            await expect(service.verify(context(), '123456')).rejects.toMatchObject({ response: { error: 'VERIFICATION_CODE_EXPIRED' } });
        });

        it('refuses to verify once the self-service closed', async () => {
            const { service, lastCode } = setup();
            await service.send(context());

            await expect(service.verify(context({ canReschedule: false, closedReason: 'window_elapsed' }), lastCode()))
                .rejects.toMatchObject({ status: 409, response: { details: { reason: 'window_elapsed' } } });
        });
    });

    describe('claimProof and releaseProof', () => {
        async function proofOf(service: VerificationCodeService, lastCode: () => string) {
            await service.send(context());
            return (await service.verify(context(), lastCode())).proof;
        }

        it('hands the proof to the first claim, and the same proof gives nothing a second time', async () => {
            const { service, lastCode } = setup();
            const proof = await proofOf(service, lastCode);

            await expect(service.claimProof(7, proof)).resolves.toMatchObject({ hash: expect.any(String), expiresAt: expect.any(Number) });
            await expect(service.claimProof(7, proof)).resolves.toBeNull();
            await expect(service.hasValidProof(7, proof)).resolves.toBe(false);
        });

        it('hands it to exactly one of many simultaneous claims', async () => {
            const { service, lastCode } = setup();
            const proof = await proofOf(service, lastCode);

            const claims = await Promise.all(Array.from({ length: 10 }, () => service.claimProof(7, proof)));

            expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
        });

        it('does not claim the proof of someone else, a wrong one or a malformed one, and leaves the real one alone', async () => {
            const { service, lastCode } = setup();
            const proof = await proofOf(service, lastCode);

            await expect(service.claimProof(8, proof)).resolves.toBeNull();
            await expect(service.claimProof(7, 'b'.repeat(64))).resolves.toBeNull();
            await expect(service.claimProof(7, 'nope')).resolves.toBeNull();
            await expect(service.claimProof(7, undefined)).resolves.toBeNull();
            await expect(service.hasValidProof(7, proof)).resolves.toBe(true);
        });

        it('does not claim a proof that already expired, even if the cache still holds it', async () => {
            const { service, lastCode } = setup();
            const proof = await proofOf(service, lastCode);

            await expect(service.claimProof(7, proof, new Date(Date.now() + 11 * MIN))).resolves.toBeNull();
        });

        it('gives back a claimed proof with the life it had left', async () => {
            vi.useFakeTimers();
            const { service, cache, lastCode } = setup();
            const proof = await proofOf(service, lastCode);
            const claimed = (await service.claimProof(7, proof))!;

            vi.advanceTimersByTime(4 * MIN);
            const store = vi.spyOn(cache, 'setIfAbsent');
            await service.releaseProof(7, claimed);

            // The store keeps it for exactly what was left (6 of the 10 minutes), not for a fresh full life.
            expect(store).toHaveBeenCalledWith('public-tracking:proof:7', expect.any(String), 6 * 60);

            await expect(service.hasValidProof(7, proof)).resolves.toBe(true);
            vi.advanceTimersByTime(6 * MIN - 1000);
            await expect(service.hasValidProof(7, proof)).resolves.toBe(true);
            vi.advanceTimersByTime(1000);
            await expect(service.hasValidProof(7, proof)).resolves.toBe(false);
        });

        it('does not bring back a proof that expired while it was claimed', async () => {
            vi.useFakeTimers();
            const { service, cache, lastCode } = setup();
            const proof = await proofOf(service, lastCode);
            const claimed = (await service.claimProof(7, proof))!;

            vi.advanceTimersByTime(10 * MIN);
            const store = vi.spyOn(cache, 'setIfAbsent');
            await service.releaseProof(7, claimed);

            await expect(service.hasValidProof(7, proof)).resolves.toBe(false);
            // Not even stored: a store whose shortest life is one second would otherwise bring it back for that second.
            expect(store).not.toHaveBeenCalled();
            await expect(cache.get('public-tracking:proof:7')).resolves.toBeNull();
        });

        it('does not spend a newer proof that replaced the checked one between the check and the removal, and puts it back', async () => {
            const { service, cache, lastCode } = setup();
            const old = await proofOf(service, lastCode);
            const newer = { hash: hashToken('c'.repeat(64)), expiresAt: Date.now() + 5 * MIN };
            // What `take` really does: the stored value leaves the cache; here it turns out to be the newer proof.
            vi.spyOn(cache, 'take').mockImplementationOnce(async (cacheKey) => { await cache.delete(cacheKey); return JSON.stringify(newer); });

            await expect(service.claimProof(7, old)).resolves.toBeNull();

            expect(JSON.parse((await cache.get('public-tracking:proof:7'))!)).toEqual(newer);
            await expect(service.hasValidProof(7, 'c'.repeat(64))).resolves.toBe(true);
        });

        it('does not overwrite a newer proof the customer got while the old one was claimed', async () => {
            const { service, lastCode } = setup();
            const old = await proofOf(service, lastCode);
            const claimed = (await service.claimProof(7, old))!;
            const fresh = await proofOf(service, lastCode);

            await service.releaseProof(7, claimed);

            await expect(service.hasValidProof(7, fresh)).resolves.toBe(true);
            await expect(service.hasValidProof(7, old)).resolves.toBe(false);
        });

        it('does not overwrite a proof issued between the check and the write of the give-back (the interleaving)', async () => {
            // A cache where, just before the give-back writes, the customer gets a newer proof: the worst moment.
            class RacingCache extends MemoryCacheAdapter {
                intruder: string | null = null;

                private async intrude(cacheKey: string, ttlSeconds: number): Promise<void> {
                    if (this.intruder === null) return;
                    const record = this.intruder;
                    this.intruder = null;
                    await super.setWithTtl(cacheKey, record, ttlSeconds);
                }

                override async setWithTtl(cacheKey: string, value: string, ttlSeconds: number): Promise<void> {
                    await this.intrude(cacheKey, ttlSeconds);
                    await super.setWithTtl(cacheKey, value, ttlSeconds);
                }

                override async setIfAbsent(cacheKey: string, value: string, ttlSeconds: number): Promise<boolean> {
                    await this.intrude(cacheKey, ttlSeconds);
                    return await super.setIfAbsent(cacheKey, value, ttlSeconds);
                }
            }
            const cache = new RacingCache();
            const { service, lastCode } = setup({ cache });
            const old = await proofOf(service, lastCode);
            const claimed = (await service.claimProof(7, old))!;
            const newer = { hash: hashToken('c'.repeat(64)), expiresAt: Date.now() + 5 * MIN };
            cache.intruder = JSON.stringify(newer);

            await service.releaseProof(7, claimed);

            expect(JSON.parse((await cache.get('public-tracking:proof:7'))!)).toEqual(newer);
            await expect(service.hasValidProof(7, 'c'.repeat(64))).resolves.toBe(true);
            await expect(service.hasValidProof(7, old)).resolves.toBe(false);
        });

        it('lets a new code and a new proof follow a spent one', async () => {
            const { service, lastCode } = setup();
            const first = await proofOf(service, lastCode);
            await service.claimProof(7, first);

            const second = await proofOf(service, lastCode);

            await expect(service.claimProof(7, second)).resolves.not.toBeNull();
        });

        it('stores the proof as a fingerprint with its expiry, never the proof itself', async () => {
            const { service, cache, lastCode } = setup();
            const proof = await proofOf(service, lastCode);

            const stored = JSON.parse((await cache.get('public-tracking:proof:7'))!);

            expect(Object.keys(stored).sort()).toEqual(['expiresAt', 'hash']);
            expect(stored.hash).toMatch(/^[0-9a-f]{64}$/);
            expect(stored.hash).not.toBe(proof);
        });

        it('answers a store that is down as 503, not as a proof that does not exist', async () => {
            const { service, cache, lastCode } = setup();
            const proof = await proofOf(service, lastCode);
            vi.spyOn(cache, 'get').mockRejectedValue(new CacheUnavailableException());

            await expect(service.claimProof(7, proof)).rejects.toMatchObject({ status: 503, response: { error: 'VERIFICATION_UNAVAILABLE' } });
        });
    });

    describe('hasValidProof', () => {
        it.each([undefined, '', 'abc', 'g'.repeat(64), 'A'.repeat(64), '0'.repeat(63)])('rejects %j without reading the cache', async (proof) => {
            const { service, cache } = setup();
            const spy = vi.spyOn(cache, 'get');

            await expect(service.hasValidProof(7, proof as string | undefined)).resolves.toBe(false);
            expect(spy).not.toHaveBeenCalled();
        });

        it('rejects a well-formed proof nobody issued', async () => {
            const { service } = setup();

            await expect(service.hasValidProof(7, 'a'.repeat(64))).resolves.toBe(false);
        });
    });
});
