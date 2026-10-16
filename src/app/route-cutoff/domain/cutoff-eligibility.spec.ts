import { describe, expect, it } from 'vitest';
import { classifyStop, partitionStops } from './cutoff-eligibility.js';
import { CUTOFF_NOW, NOTIFIED_TODAY, stop } from './cutoff-fixtures.helper-spec.js';

const WINDOW = 720;

describe('classifyStop', () => {
    it('lets a firm promise in', () => {
        expect(classifyStop(stop(1, { firmed: true, notifiedAt: NOTIFIED_TODAY }), CUTOFF_NOW, WINDOW)).toBe('firm');
    });

    it('lets in a promise whose 12 h already ended even if the closing task has not firmed it yet', () => {
        expect(classifyStop(stop(1), CUTOFF_NOW, WINDOW)).toBe('window_elapsed');
    });

    it('leaves out a promise the customer can still answer', () => {
        expect(classifyStop(stop(1, { notifiedAt: NOTIFIED_TODAY }), CUTOFF_NOW, WINDOW)).toBe('window_open');
    });

    it('enters on the exact end of the window', () => {
        const notifiedAt = new Date(CUTOFF_NOW.getTime() - WINDOW * 60_000);
        expect(classifyStop(stop(1, { notifiedAt }), CUTOFF_NOW, WINDOW)).toBe('window_elapsed');
    });

    it('does not start the clock without a valid notice (bounced email)', () => {
        expect(classifyStop(stop(1, { notifiedAt: null }), CUTOFF_NOW, WINDOW)).toBe('window_open');
    });

    it('treats an order that was never approved as without promise', () => {
        expect(classifyStop(stop(1, { status: 'in_planning' }), CUTOFF_NOW, WINDOW)).toBe('no_promise');
    });
});

describe('partitionStops', () => {
    it('splits a batch into the three groups', () => {
        const result = partitionStops(
            [stop(1), stop(2, { firmed: true }), stop(3, { notifiedAt: NOTIFIED_TODAY }), stop(4, { status: 'in_planning' })],
            CUTOFF_NOW,
            WINDOW,
        );
        expect(result.eligible.map((s) => s.dispatch.dispatchId)).toEqual([1, 2]);
        expect(result.open.map((s) => s.dispatch.dispatchId)).toEqual([3]);
        expect(result.withoutPromise.map((s) => s.dispatch.dispatchId)).toEqual([4]);
    });
});
