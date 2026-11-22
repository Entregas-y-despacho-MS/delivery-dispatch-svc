import { describe, expect, it } from 'vitest';
import { isAuthorizationPending, nextActionOf } from './next-action.js';

const base = { verdict: null, rmaId: null, eligible: true } as const;

describe('nextActionOf', () => {
    it.each([
        ['received', 'assign'],
        ['assigned', 'start_investigation'],
        ['in_investigation', 'issue_verdict'],
    ] as const)('an eligible %s case asks for %s', (investigationStatus, expected) => {
        expect(nextActionOf({ ...base, investigationStatus })).toBe(expected);
    });

    it('offers nothing while the dispatch is not delivered', () => {
        for (const investigationStatus of ['received', 'assigned', 'in_investigation'] as const) {
            expect(nextActionOf({ ...base, investigationStatus, eligible: false })).toBe('none');
        }
    });

    it('a request_RMA verdict waits for Inventory until the RMA id arrives', () => {
        const decided = { investigationStatus: 'decided', eligible: true } as const;
        expect(nextActionOf({ ...decided, verdict: 'request_RMA', rmaId: null })).toBe('await_inventory_authorization');
        expect(nextActionOf({ ...decided, verdict: 'request_RMA', rmaId: 'RMA-1' })).toBe('none');
    });

    it('the other two verdicts leave nothing to do', () => {
        for (const verdict of ['no_return_required', 'not_confirmed'] as const) {
            expect(nextActionOf({ investigationStatus: 'decided', verdict, rmaId: null, eligible: true })).toBe('none');
        }
    });

    it('a decided case keeps its next step even if the dispatch is no longer delivered', () => {
        expect(nextActionOf({ investigationStatus: 'decided', verdict: 'request_RMA', rmaId: null, eligible: false })).toBe('await_inventory_authorization');
    });
});

describe('isAuthorizationPending', () => {
    it('is true only for request_RMA without an RMA id', () => {
        expect(isAuthorizationPending('request_RMA', null)).toBe(true);
        expect(isAuthorizationPending('request_RMA', 'RMA-1')).toBe(false);
        expect(isAuthorizationPending('not_confirmed', null)).toBe(false);
        expect(isAuthorizationPending(null, null)).toBe(false);
    });
});
