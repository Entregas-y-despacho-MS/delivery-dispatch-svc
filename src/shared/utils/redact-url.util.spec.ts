import { describe, expect, it } from 'vitest';
import { redactTrackingToken } from './redact-url.util.js';

describe('redactTrackingToken', () => {
    it('hides the token of the view URL', () => {
        expect(redactTrackingToken('/api/public/tracking/5b0a7c1e-0d0e-4a44-9d5f-3a1b2c3d4e5f'))
            .toBe('/api/public/tracking/:token');
    });

    it('keeps the action that follows the token', () => {
        expect(redactTrackingToken('/api/public/tracking/abc123-token/verification-code/verify'))
            .toBe('/api/public/tracking/:token/verification-code/verify');
    });

    it('drops the query string value that sits in the token segment only', () => {
        expect(redactTrackingToken('/api/public/tracking/abc123-token?x=1')).toBe('/api/public/tracking/:token?x=1');
    });

    it('leaves every other URL as it came', () => {
        expect(redactTrackingToken('/api/route-batches/7')).toBe('/api/route-batches/7');
        expect(redactTrackingToken('/api/public/tracking')).toBe('/api/public/tracking');
    });
});
