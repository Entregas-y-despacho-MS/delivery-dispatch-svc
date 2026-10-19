import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { LocalStorageAdapter } from './local.adapter.js';
import type { LocalStorageConfig } from './local.config.js';

const NAME = '0b1f6c9e-3a52-4c7e-9d1a-5b7a2f8c1e44.jpg';

describe('LocalStorageAdapter — signed access URLs', () => {
    let adapter: LocalStorageAdapter;

    beforeEach(() => {
        const config = {
            uploadsDir: 'uploads',
            publicUrl:  'http://api.test',
            apiPrefix:  'api',
            signingKey: createHash('sha256').update('k').digest(),
        } as LocalStorageConfig;
        adapter = new LocalStorageAdapter(config);
    });
    afterEach(() => vi.useRealTimers());

    const parse = (url: string) => {
        const u = new URL(url);
        return { path: u.pathname, exp: Number(u.searchParams.get('exp')), sig: u.searchParams.get('sig')! };
    };

    it('returns a URL under the API prefix with exp and sig, never the stored path', async () => {
        const { url, expiresAt } = await adapter.getAccessUrl(`http://api.test/uploads/${NAME}`, 300);
        const { path, exp } = parse(url);
        expect(path).toBe(`/api/uploads/${NAME}`);
        expect(exp).toBe(Math.floor(expiresAt.getTime() / 1000));
        expect(url).not.toContain('/api/uploads/uploads');
    });

    it('accepts the issued signature before it expires', async () => {
        const { url } = await adapter.getAccessUrl(`http://api.test/uploads/${NAME}`, 300);
        const { exp, sig } = parse(url);
        expect(adapter.verifyAccess(NAME, exp, sig)).toBe(true);
    });

    it('rejects it once the TTL has passed', async () => {
        vi.useFakeTimers();
        const { url } = await adapter.getAccessUrl(`http://api.test/uploads/${NAME}`, 60);
        const { exp, sig } = parse(url);
        vi.advanceTimersByTime(61_000);
        expect(adapter.verifyAccess(NAME, exp, sig)).toBe(false);
    });

    it('rejects a signature used for another file, another expiry, or a malformed one', async () => {
        const { url } = await adapter.getAccessUrl(`http://api.test/uploads/${NAME}`, 300);
        const { exp, sig } = parse(url);
        expect(adapter.verifyAccess(NAME.replace('0b1f', '0b1e'), exp, sig)).toBe(false);
        expect(adapter.verifyAccess(NAME, exp + 3600, sig)).toBe(false);
        expect(adapter.verifyAccess(NAME, exp, 'abc')).toBe(false);
        expect(adapter.verifyAccess(NAME, Number.NaN, sig)).toBe(false);
    });

    it('only resolves names it generated (no path traversal)', () => {
        expect(adapter.resolvePath(NAME)).toContain('uploads');
        expect(adapter.resolvePath('../.env')).toBeNull();
        expect(adapter.resolvePath('..%2F.env')).toBeNull();
        expect(adapter.resolvePath('index.html')).toBeNull();
    });
});
