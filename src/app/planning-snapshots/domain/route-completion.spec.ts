import { describe, expect, it } from 'vitest';
import { OUTCOMES, departedOf, emptyCounts, finalizedOf, percentOf, summarizeRoute, sumCounts, type BaselineStop } from './route-completion.js';

const stop = (dispatchId: number, currentStatus: string, over: Partial<BaselineStop> = {}): BaselineStop => ({
    dispatchId,
    dispatchType: 'delivery',
    currentStatus,
    sequenceOrder: dispatchId,
    startedState: 'departing',
    ...over,
});

describe('summarizeRoute', () => {
    it('puts every stop in exactly one category and keeps the categories apart', () => {
        const result = summarizeRoute([
            stop(1, 'delivered'),
            stop(2, 'delivered'),
            stop(3, 'picked_up_in_transit', { dispatchType: 'supplier_pickup' }),
            stop(4, 'not_delivered'),
            stop(5, 'out_for_delivery'),
            stop(6, 'assigned', { startedState: 'excluded' }),
            stop(7, 'cancelled', { startedState: null }),
            stop(8, 'rescheduled', { startedState: null }),
        ]);

        expect(result.counts).toEqual({
            delivered: 2,
            pickup_completed: 1,
            unsuccessful: 1,
            pending: 1,
            excluded_at_start: 1,
            cancelled_before_start: 1,
            removed_before_start: 1,
        });
        expect(Object.values(result.counts).reduce((a, b) => a + b, 0)).toBe(result.stops.length);
    });

    it('measures completion only over the stops that left with the route', () => {
        const result = summarizeRoute([
            stop(1, 'delivered'),
            stop(2, 'not_delivered'),
            stop(3, 'out_for_delivery'),
            stop(4, 'out_for_delivery'),
            stop(5, 'assigned', { startedState: 'excluded' }),
            stop(6, 'cancelled', { startedState: null }),
        ]);

        expect(result).toMatchObject({ departed: 4, finalized: 2, finalizedPct: 50 });
    });

    it('keeps the same baseline while the route advances: only the outcomes move', () => {
        const before = summarizeRoute([stop(1, 'out_for_delivery'), stop(2, 'out_for_delivery'), stop(3, 'out_for_delivery')]);
        const after = summarizeRoute([stop(1, 'delivered'), stop(2, 'not_delivered'), stop(3, 'out_for_delivery')]);

        expect(after.stops.map((s) => s.dispatchId)).toEqual(before.stops.map((s) => s.dispatchId));
        expect(after.departed).toBe(before.departed);
        expect(before.finalized).toBe(0);
        expect(after.finalized).toBe(2);
    });

    it('does not wait for the batch to close: a delivered stop is final while the others are open', () => {
        const result = summarizeRoute([stop(1, 'delivered'), stop(2, 'out_for_delivery')]);
        expect(result.stops[0].outcome).toBe('delivered');
        expect(result.stops[1].outcome).toBe('pending');
    });

    it('separates a cancellation before the start from any other way of leaving the route', () => {
        const result = summarizeRoute([stop(1, 'cancelled', { startedState: null }), stop(2, 'rescheduled', { startedState: null })]);
        expect(result.stops.map((s) => s.outcome)).toEqual(['cancelled_before_start', 'removed_before_start']);
        expect(result).toMatchObject({ departed: 0, finalized: 0, finalizedPct: null });
    });

    it('orders by visiting order, with the stops without sequence last', () => {
        const result = summarizeRoute([stop(9, 'delivered', { sequenceOrder: null }), stop(5, 'delivered', { sequenceOrder: 2 }), stop(7, 'delivered', { sequenceOrder: 1 })]);
        expect(result.stops.map((s) => s.dispatchId)).toEqual([7, 5, 9]);
    });

    it('does not change its input', () => {
        const input = [stop(2, 'delivered'), stop(1, 'delivered')];
        const copy = input.map((item) => ({ ...item }));
        summarizeRoute(input);
        expect(input).toEqual(copy);
    });

    it('is empty for a route with no baseline', () => {
        expect(summarizeRoute([])).toMatchObject({ stops: [], departed: 0, finalized: 0, finalizedPct: null });
    });
});

describe('counts helpers', () => {
    it('sums routes category by category', () => {
        const a = { ...emptyCounts(), delivered: 2, pending: 1 };
        const b = { ...emptyCounts(), delivered: 1, unsuccessful: 3 };
        const total = sumCounts([a, b]);
        expect(total.delivered).toBe(3);
        expect(total.unsuccessful).toBe(3);
        expect(finalizedOf(total)).toBe(6);
        expect(departedOf(total)).toBe(7);
    });

    it('lists every category once', () => {
        expect(new Set(OUTCOMES).size).toBe(OUTCOMES.length);
        expect(Object.keys(emptyCounts()).sort()).toEqual([...OUTCOMES].sort());
    });

    it('has no percentage over nothing and rounds to two decimals', () => {
        expect(percentOf(0, 0)).toBeNull();
        expect(percentOf(1, 3)).toBe(33.33);
    });
});
