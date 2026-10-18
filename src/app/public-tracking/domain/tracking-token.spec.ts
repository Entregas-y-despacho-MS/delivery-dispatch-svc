import { describe, expect, it } from 'vitest';
import { isWellFormedTrackingToken } from './tracking-token.js';

describe('isWellFormedTrackingToken', () => {
    it('accepts a UUID', () => {
        expect(isWellFormedTrackingToken('5b0a7c1e-0d0e-4a44-9d5f-3a1b2c3d4e5f')).toBe(true);
    });

    it('accepts the longest value the column holds', () => {
        expect(isWellFormedTrackingToken('a'.repeat(100))).toBe(true);
        expect(isWellFormedTrackingToken('a'.repeat(101))).toBe(false);
    });

    it.each(['', 'short', 'has space in it', 'semi;colon-token', 'quote\'token-12345', 'üñíçode-token-1', 'a/b/c/d/e/f/g/h', '%00%00%00%00%00'])(
        'rejects %j',
        (value) => {
            expect(isWellFormedTrackingToken(value)).toBe(false);
        },
    );
});
