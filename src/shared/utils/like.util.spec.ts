import { describe, expect, it } from 'vitest';
import { escapeLike } from './like.util.js';

describe('escapeLike', () => {
    it('deja igual el texto normal', () => {
        expect(escapeLike('carlos')).toBe('carlos');
        expect(escapeLike('Ana María')).toBe('Ana María');
        expect(escapeLike('')).toBe('');
    });

    it('escapa % y _ para que se busquen literalmente', () => {
        expect(escapeLike('50%')).toBe('50\\%');
        expect(escapeLike('a_b')).toBe('a\\_b');
        expect(escapeLike('%%__')).toBe('\\%\\%\\_\\_');
    });

    it('escapa la propia barra invertida (si no, "\\%" volvería a ser comodín)', () => {
        expect(escapeLike('a\\b')).toBe('a\\\\b');
        expect(escapeLike('\\%')).toBe('\\\\\\%');
    });
});
