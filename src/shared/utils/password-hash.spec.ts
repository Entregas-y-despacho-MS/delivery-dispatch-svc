// hashPassword / comparePassword: bcrypt on its own accepts other texts than the password; these must not.
import { describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcrypt';
import { comparePassword, hashPassword, hashShortCode, isHashableText, wasPasswordUsed } from './crypto.util.js';

const legacyHash = (text: string) => bcrypt.hash(text, 4);

describe('hashPassword / comparePassword', () => {
    it('the stored value is versioned, fits password_hash VARCHAR(255) and changes on every call', async () => {
        const first = await hashPassword('Passw0rd!');
        expect(first).toMatch(/^bcrypt-sha384:\$2b\$10\$.{53}$/);
        expect(first.length).toBeLessThanOrEqual(255);
        expect(await hashPassword('Passw0rd!')).not.toBe(first);
    });

    const base = 'Aa1!'.repeat(32); // 128 characters
    const cases: Array<[string, string, string[]]> = [
        ['128 characters', base, [base.slice(0, 72), base.slice(0, 72) + 'z'.repeat(56), base.slice(0, 127), base + 'x']],
        ['255 characters', 'Aa1!x'.repeat(51), ['Aa1!x'.repeat(50) + 'Aa1!y']],
        ['exactly 72 bytes', 'a'.repeat(72), ['a'.repeat(73), 'a'.repeat(71)]],
        ['72 bytes of multibyte text', 'ñ'.repeat(36), ['ñ'.repeat(36) + 'x', 'ñ'.repeat(35)]],
        ['emojis past byte 72', '🔒'.repeat(30), ['🔒'.repeat(29) + '🔑', '🔒'.repeat(18)]],
        ['short, against the NUL cycle', 'Abc1!xyz', ['Abc1!xyz\0Abc1!xyz', 'Abc1!xyz\0', 'abc1!xyz', 'Abc1!xyz ', ' Abc1!xyz', '']],
    ];

    it.each(cases)('%s: only the exact text matches', async (_name, password, others) => {
        const stored = await hashPassword(password);
        expect(await comparePassword(password, stored)).toBe(true);
        for (const other of others) expect(await comparePassword(other, stored), JSON.stringify(other)).toBe(false);
    });

    it('tells apart NFC and NFD forms: nothing is normalised', async () => {
        const stored = await hashPassword('Contraseña1!'.normalize('NFC'));
        expect(await comparePassword('Contraseña1!'.normalize('NFD'), stored)).toBe(false);
    });

    it('isHashableText refuses NUL, lone surrogates and U+FFFD, and accepts paired surrogates', () => {
        for (const bad of ['a\0b', '\0', 'a\uD800', '\uDC00a', '\uDC00\uD800', 'a\uFFFD']) expect(isHashableText(bad), JSON.stringify(bad)).toBe(false);
        for (const good of ['abc', 'ñ€', '🔒', ' ']) expect(isHashableText(good), JSON.stringify(good)).toBe(true);
    });

    it('never hashes ambiguous text', async () => {
        await expect(hashPassword('Abc1!xyz\0')).rejects.toThrow();
        await expect(hashPassword('Abc1!xyz\uD800')).rejects.toThrow();
        await expect(hashPassword('Abc1!xyz\uFFFD')).rejects.toThrow();
    });
});

describe('comparePassword against an older hash (bcrypt on the text itself)', () => {
    it('keeps accepting a password of up to 71 bytes', async () => {
        for (const password of ['Passw0rd!', 'a'.repeat(71), 'ñ'.repeat(35)]) {
            expect(await comparePassword(password, await legacyHash(password)), password).toBe(true);
        }
    });

    it('a password of 71 bytes does not match anything longer', async () => {
        expect(await comparePassword('a'.repeat(71) + 'x', await legacyHash('a'.repeat(71)))).toBe(false);
    });

    it('refuses every text, the original included, once 72 bytes or more are needed: it must be reset', async () => {
        const original = 'Aa1!'.repeat(32);
        const stored = await legacyHash(original);
        for (const candidate of [original, original.slice(0, 72), original.slice(0, 72) + 'otro', original.slice(0, 71)]) {
            expect(await comparePassword(candidate, stored), candidate).toBe(false);
        }
        expect(await comparePassword('ñ'.repeat(36), await legacyHash('ñ'.repeat(36)))).toBe(false);
    });

    it('refuses the NUL cycle and the surrogate twins', async () => {
        expect(await comparePassword('Abc1!xyz\0Abc1!xyz', await legacyHash('Abc1!xyz'))).toBe(false);
        const withSurrogate = await legacyHash('Abc1!xyz\uD800');
        expect(await comparePassword('Abc1!xyz\uDBFF', withSurrogate)).toBe(false);
        expect(await comparePassword('Abc1!xyz�', withSurrogate)).toBe(false);
    });
});

describe('the answer takes one bcrypt comparison, whatever the reason', () => {
    it.each([
        ['new hash, ambiguous text', true, 'a\0'],
        ['older hash, too long', false, 'a'.repeat(100)],
        ['older hash, ambiguous text', false, 'a\uD800'],
    ])('%s', async (_name, isNew, candidate) => {
        const stored = isNew ? await hashPassword('Passw0rd!') : await legacyHash('Passw0rd!');
        const compare = vi.spyOn(bcrypt, 'compare');
        expect(await comparePassword(candidate, stored)).toBe(false);
        expect(compare).toHaveBeenCalledTimes(1);
        compare.mockRestore();
    });
});

describe('wasPasswordUsed (reuse check)', () => {
    const first = 'Aa1!'.repeat(18) + 'Uno1!';
    const second = 'Aa1!'.repeat(18) + 'Dos2!';

    it('new hashes: two passwords that differ only past byte 72 are different', async () => {
        const stored = await hashPassword(first);
        expect(await wasPasswordUsed(first, stored)).toBe(true);
        expect(await wasPasswordUsed(second, stored)).toBe(false);
    });

    it('older hashes: errs on the side of "used", so a long one cannot be set again', async () => {
        const stored = await legacyHash(first);
        expect(await wasPasswordUsed(first, stored)).toBe(true);
        expect(await wasPasswordUsed(second, stored)).toBe(true);
        expect(await wasPasswordUsed('OtraClave1!', stored)).toBe(false);
    });
});

describe('hashShortCode (OTP and other server-generated codes)', () => {
    it('stays plain bcrypt, and comparePassword checks it exactly', async () => {
        const stored = await hashShortCode('123456');
        expect(stored).toMatch(/^\$2b\$10\$/);
        expect(await comparePassword('123456', stored)).toBe(true);
        for (const other of ['123457', '123456\x00123456', '1234560', '']) {
            expect(await comparePassword(other, stored), JSON.stringify(other)).toBe(false);
        }
    });
});
