import { describe, expect, it } from 'vitest';
import type { DispatchStatusChangedEvent } from '../../dispatch-status/dispatch-status-changed.event.js';
import { buildStatusNotice, eligibleStatusNotice, formatOccurredAt, trackingLink, type StatusNoticeDispatch } from './build-status-notice.js';
import { STATUS_NOTICE_TABLE } from './status-notice-table.js';

const event = (over: Partial<DispatchStatusChangedEvent> = {}): DispatchStatusChangedEvent => ({
    dispatchId: 7, status: 'out_for_delivery', previousStatus: 'assigned', version: 3, updatedAt: '2026-11-19T14:30:00.000Z', ...over,
});
const dispatch = (over: Partial<StatusNoticeDispatch> = {}): StatusNoticeDispatch => ({
    dispatchId: 7, type: 'delivery', currentStatus: 'out_for_delivery', contactEmail: 'ana@example.com', trackingCode: 'DSP-2026-00007',
    trackingToken: 'secret-token', trackingTokenExpiresAt: null, ...over,
});

describe('eligibleStatusNotice', () => {
    it.each(Object.keys(STATUS_NOTICE_TABLE))('notifies the transition to %s', (status) => {
        expect(eligibleStatusNotice({ status, previousStatus: 'assigned' })).toBe(STATUS_NOTICE_TABLE[status]);
    });

    it.each(['pending', 'in_planning', 'address_review', 'assigned', 'scheduled', 'pickup_scheduled', 'picked_up_in_transit', 'returned_to_warehouse', 'constructor'])(
        'does not notify the internal status %s', (status) => {
            expect(eligibleStatusNotice({ status, previousStatus: 'pending' })).toBeNull();
        },
    );

    it('does not notify a transition to the same status', () => {
        expect(eligibleStatusNotice({ status: 'incident', previousStatus: 'incident' })).toBeNull();
    });
});

describe('buildStatusNotice', () => {
    it('builds the payload with the public reference, the shown status, the instant and the recipient', () => {
        expect(buildStatusNotice(event(), dispatch())).toEqual({
            dispatchId: 7,
            trackingCode: 'DSP-2026-00007',
            status: 'out_for_delivery',
            statusLabel: 'En ruta',
            message: STATUS_NOTICE_TABLE.out_for_delivery!.message,
            subject: STATUS_NOTICE_TABLE.out_for_delivery!.subject,
            occurredAt: '2026-11-19T14:30:00.000Z',
            recipient: 'ana@example.com',
        });
    });

    it('never carries the tracking token or any other internal data', () => {
        const payload = JSON.stringify(buildStatusNotice(event(), dispatch({ trackingToken: 'secret-token' })));
        expect(payload).not.toContain('secret-token');
        expect(payload).not.toMatch(/phone|address|token/i);
    });

    it('returns null for an internal transition, a pickup, a missing recipient or an invalid date', () => {
        expect(buildStatusNotice(event({ status: 'assigned', previousStatus: 'scheduled' }), dispatch())).toBeNull();
        expect(buildStatusNotice(event(), dispatch({ type: 'supplier_pickup' }))).toBeNull();
        expect(buildStatusNotice(event(), dispatch({ contactEmail: null }))).toBeNull();
        expect(buildStatusNotice(event(), dispatch({ contactEmail: '   ' }))).toBeNull();
        expect(buildStatusNotice(event({ updatedAt: 'not a date' }), dispatch())).toBeNull();
    });
});

describe('trackingLink', () => {
    const now = new Date('2026-11-19T15:00:00Z');

    it('builds the link with the token while it is valid', () => {
        expect(trackingLink(dispatch(), 'http://web.test', now)).toBe('http://web.test/seguimiento/secret-token');
        expect(trackingLink(dispatch({ trackingTokenExpiresAt: new Date('2026-11-20T00:00:00Z') }), 'http://web.test', now)).toBe('http://web.test/seguimiento/secret-token');
    });

    it('gives no link when there is no token or it expired', () => {
        expect(trackingLink(dispatch({ trackingToken: null }), 'http://web.test', now)).toBe('');
        expect(trackingLink(dispatch({ trackingTokenExpiresAt: new Date('2026-11-19T15:00:00Z') }), 'http://web.test', now)).toBe('');
    });
});

describe('formatOccurredAt', () => {
    it('shows date and time in La Paz time', () => {
        const text = formatOccurredAt('2026-11-19T14:30:00.000Z'); // 10:30 in UTC-4
        expect(text).toContain('2026');
        expect(text).toContain('10:30');
    });
});
