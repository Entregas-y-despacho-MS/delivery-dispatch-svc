import { describe, expect, it } from 'vitest';
import { getCorsOptions } from './cors.js';

describe('getCorsOptions', () => {
    it.each(['*', 'https://web.example.com,https://admin.example.com'])('exposes X-Request-Id to browsers (%s)', (origins) => {
        expect(getCorsOptions(origins).exposedHeaders).toEqual(['X-Request-Id']);
    });
});
