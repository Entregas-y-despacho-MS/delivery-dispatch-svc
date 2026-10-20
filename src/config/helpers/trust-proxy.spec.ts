import { describe, expect, it } from 'vitest';
import { parseTrustProxy } from './trust-proxy.js';

describe('parseTrustProxy', () => {
    it('trusts nothing when the variable is empty, unset or false', () => {
        expect(parseTrustProxy(undefined)).toBe(false);
        expect(parseTrustProxy('')).toBe(false);
        expect(parseTrustProxy('  ')).toBe(false);
        expect(parseTrustProxy('false')).toBe(false);
        expect(parseTrustProxy('0')).toBe(false);
    });

    it('reads a number of hops', () => {
        expect(parseTrustProxy('1')).toBe(1);
        expect(parseTrustProxy(' 2 ')).toBe(2);
    });

    it('reads a list of addresses, ranges and Express names', () => {
        expect(parseTrustProxy('loopback, 10.0.0.0/8,172.16.0.1')).toEqual(['loopback', '10.0.0.0/8', '172.16.0.1']);
        expect(parseTrustProxy('::1, fc00::/7')).toEqual(['::1', 'fc00::/7']);
        expect(parseTrustProxy('uniquelocal')).toEqual(['uniquelocal']);
    });

    it('rejects "true" and anything else it does not understand, so a client cannot forge its address', () => {
        expect(() => parseTrustProxy('true')).toThrow(/not valid/);
        expect(() => parseTrustProxy('10.0.0.1, banana')).toThrow(/banana/);
        expect(() => parseTrustProxy('-1')).toThrow(/not valid/);
    });
});
