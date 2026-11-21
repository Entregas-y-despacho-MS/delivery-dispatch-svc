import { describe, expect, it } from 'vitest';
import { STATUS_CHANGE_NOTIFICATION, idempotencyKey, normalizeRecipient, sourceEventKey } from './idempotency.js';

describe('idempotency key', () => {
    const at = '2026-11-19T14:30:00.000Z';

    it('is the notification type plus the source event', () => {
        expect(idempotencyKey(STATUS_CHANGE_NOTIFICATION, sourceEventKey(7, 'delivered', at))).toBe(`status_change:7:delivered:${at}`);
    });

    it('is the same for two deliveries of the same event', () => {
        const first = idempotencyKey(STATUS_CHANGE_NOTIFICATION, sourceEventKey(7, 'delivered', at));
        const second = idempotencyKey(STATUS_CHANGE_NOTIFICATION, sourceEventKey(7, 'delivered', at));
        expect(second).toBe(first);
    });

    it.each([
        ['another dispatch', sourceEventKey(8, 'delivered', at)],
        ['another status', sourceEventKey(7, 'incident', at)],
        ['another instant (a new passage through the same status)', sourceEventKey(7, 'delivered', '2026-11-19T15:00:00.000Z')],
    ])('differs for %s', (_label, other) => {
        expect(idempotencyKey(STATUS_CHANGE_NOTIFICATION, other)).not.toBe(idempotencyKey(STATUS_CHANGE_NOTIFICATION, sourceEventKey(7, 'delivered', at)));
    });

    it('differs for another type of notification of the same event', () => {
        const source = sourceEventKey(7, 'delivered', at);
        expect(idempotencyKey('other_type', source)).not.toBe(idempotencyKey(STATUS_CHANGE_NOTIFICATION, source));
    });

    it('fits the columns: the key in 200 characters and the source event in 120, for the longest status', () => {
        const source = sourceEventKey(2_147_483_647, 'x'.repeat(30), at);
        expect(source.length).toBeLessThanOrEqual(120);
        expect(idempotencyKey(STATUS_CHANGE_NOTIFICATION, source).length).toBeLessThanOrEqual(200);
    });
});

describe('normalizeRecipient', () => {
    it('trims and lower-cases the address', () => expect(normalizeRecipient('  Ana.Perez@Example.COM \n')).toBe('ana.perez@example.com'));
    it('makes two spellings of one address the same recipient', () => expect(normalizeRecipient('ANA@x.com')).toBe(normalizeRecipient(' ana@X.com')));
});
