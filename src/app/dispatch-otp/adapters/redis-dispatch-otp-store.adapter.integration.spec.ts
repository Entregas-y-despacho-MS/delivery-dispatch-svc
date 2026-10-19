import { createClient, type RedisClientType } from 'redis';
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisDispatchOtpStore } from './redis-dispatch-otp-store.adapter.js';

// Only use an explicitly selected disposable Redis. Never infer a developer/shared instance.
const port = Number(process.env.OTP_TEST_REDIS_PORT);
describe.skipIf(!port)('OTP atomic store against disposable Redis', () => {
    let store: RedisDispatchOtpStore;
    let client: RedisClientType;
    const ids: number[] = [];
    const id = () => { const n = randomInt(100000, 2000000000); ids.push(n); return n; };
    beforeAll(async () => {
        store = new RedisDispatchOtpStore({ host: '127.0.0.1', port } as any);
        // The adapter follows the existing nonblocking cache startup convention.
        await store.onModuleInit();
        client = createClient({ socket: { host: '127.0.0.1', port } });
        await client.connect();
        for (let n = 0; n < 100; n++) {
            try { await store.readHash(1); break; } catch { await new Promise((r) => setTimeout(r, 10)); }
        }
    });
    afterAll(async () => {
        for (const n of ids) await client.del([`dispatch-otp:{${n}}:limits`, `dispatch-otp:{${n}}:code`]);
        await store.onModuleDestroy();
        await client.quit();
    });
    it('allows one initial issue and exactly two concurrent resends', async () => {
        const n = id();
        expect(await store.issue(n, 'hash0', 20)).toBe('issued');
        expect(await store.issue(n, 'ignored', 20)).toBe('already_issued');
        const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.issue(n, `hash${i + 1}`, 20, true)));
        expect(results.filter((r) => r === 'issued')).toHaveLength(2);
        expect(results.filter((r) => r === 'resend_limit')).toHaveLength(8);
    });
    it('blocks at three wrong attempts and keeps failures across resend and expiry', async () => {
        const n = id();
        await store.issue(n, 'oldhash', 1);
        expect(await store.verify(n, 'oldhash', false)).toBe('invalid');
        await new Promise((r) => setTimeout(r, 1100));
        expect(await store.readHash(n)).toBeNull();
        expect(await store.issue(n, 'newhash', 20, true)).toBe('issued');
        expect(await store.verify(n, 'oldhash', true)).toBe('replaced');
        expect(await store.verify(n, 'newhash', false)).toBe('invalid');
        expect(await store.verify(n, 'newhash', false)).toBe('locked');
        expect(await store.issue(n, 'next', 20, true)).toBe('locked');
        expect(await store.readHash(n)).toBeNull();
    });
    it('consumes exactly once and does not consume a replaced generation', async () => {
        const n = id();
        await store.issue(n, 'old', 20);
        await store.issue(n, 'new', 20, true);
        expect(await store.verify(n, 'old', true)).toBe('replaced');
        const results = await Promise.all(Array.from({ length: 10 }, () => store.verify(n, 'new', true)));
        expect(results.filter((r) => r === 'verified')).toHaveLength(1);
        expect(results.filter((r) => r === 'consumed')).toHaveLength(9);
        expect(await store.issue(n, 'again', 20, true)).toBe('consumed');
    });
    it('records the evidence id with the consumption and never overwrites it', async () => {
        const n = id();
        await store.issue(n, 'hash', 20);
        expect(await store.readVerifiedEvidenceId(n)).toBeNull();
        expect(await store.verify(n, 'hash', false, 'ignored-on-failure')).toBe('invalid');
        expect(await store.readVerifiedEvidenceId(n)).toBeNull();
        const results = await Promise.all(['e1', 'e2', 'e3', 'e4'].map((evidenceId) => store.verify(n, 'hash', true, evidenceId)));
        expect(results.filter((r) => r === 'verified')).toHaveLength(1);
        const recorded = await store.readVerifiedEvidenceId(n);
        expect(['e1', 'e2', 'e3', 'e4']).toContain(recorded);
        expect(await store.verify(n, 'hash', true, 'late')).toBe('consumed');
        expect(await store.readVerifiedEvidenceId(n)).toBe(recorded);
        expect(await client.ttl(`dispatch-otp:{${n}}:limits`)).toBe(-1);
    });
    it('resets code TTL on resend and leaves budget metadata without TTL', async () => {
        const n = id();
        await store.issue(n, 'old', 1);
        await store.issue(n, 'new', 90, true);
        expect(await client.ttl(`dispatch-otp:{${n}}:code`)).toBeGreaterThan(85);
        expect(await client.ttl(`dispatch-otp:{${n}}:limits`)).toBe(-1);
        await store.invalidate(n, 'old');
        expect(await store.readHash(n)).toBe('new');
        await store.invalidate(n, 'new');
        expect(await store.readHash(n)).toBeNull();
    });
});
