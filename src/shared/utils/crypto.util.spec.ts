// hashToken / tokenMatchesHash: how refresh tokens are fingerprinted (see the doc comment in crypto.util.ts).
import { describe, expect, it } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { hashPassword, hashToken, tokenMatchesHash } from './crypto.util.js';

// Real tokens for the same user, exactly as auth.service issues them: same payload, different `jwtid`.
const jwt = new JwtService({});
const issue = (jti: string) => jwt.sign({ sub: 1, username: 'root', roleId: 1, role: 'root' }, { secret: 's', expiresIn: '7d', jwtid: jti });

describe('hashToken / tokenMatchesHash', () => {
    it('the same token matches its own fingerprint', () => {
        const token = issue('a');
        expect(tokenMatchesHash(token, hashToken(token))).toBe(true);
    });

    it('another token of the same user (same header and payload start) does NOT match', () => {
        const stored = issue('a');
        const other  = issue('b');

        // The two tokens share their first 72 bytes: that is all bcrypt reads, so bcrypt could not tell them apart.
        expect(other.slice(0, 72)).toBe(stored.slice(0, 72));
        expect(other).not.toBe(stored);
        expect(tokenMatchesHash(other, hashToken(stored))).toBe(false);
    });

    it('documents the bug it replaces: bcrypt accepts a different token with the same first 72 bytes', async () => {
        const stored = issue('a');
        const other  = issue('b');
        const bcrypt = (await import('bcrypt')).default;

        expect(await bcrypt.compare(other, await hashPassword(stored))).toBe(true);
    });

    it('a tampered token does not match', () => {
        const token = issue('a');
        expect(tokenMatchesHash(token + 'x', hashToken(token))).toBe(false);
    });

    it('a legacy bcrypt hash (or any garbage) in the database never matches, and does not throw', async () => {
        const token = issue('a');
        expect(tokenMatchesHash(token, await hashPassword(token))).toBe(false);
        expect(tokenMatchesHash(token, '')).toBe(false);
        expect(tokenMatchesHash(token, 'not-hex')).toBe(false);
    });

    it('the fingerprint is a 64-character hex string', () => {
        expect(hashToken('anything')).toMatch(/^[0-9a-f]{64}$/);
    });
});
