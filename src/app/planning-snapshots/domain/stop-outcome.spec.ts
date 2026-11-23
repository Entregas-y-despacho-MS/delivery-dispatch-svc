import { describe, expect, it } from 'vitest';
import { classifyRemovedBeforeStart, classifyStopOutcome, isPickupType } from './stop-outcome.js';

const outcome = (dispatchType: string, dispatchStatus: string, stopState: 'departing' | 'excluded' = 'departing') =>
    classifyStopOutcome({ stopState, dispatchType, dispatchStatus });

describe('classifyStopOutcome of a delivery', () => {
    it('is delivered only when the dispatch reached delivered', () => {
        expect(outcome('delivery', 'delivered')).toBe('delivered');
    });

    it.each(['not_delivered', 'incident', 'returned', 'returned_to_warehouse', 'rescheduled', 'cancelled'])(
        'is unsuccessful when the route left and the dispatch is %s',
        (status) => {
            expect(outcome('delivery', status)).toBe('unsuccessful');
        },
    );

    it.each(['assigned', 'out_for_delivery', 'in_transit'])('stays pending while the dispatch is %s', (status) => {
        expect(outcome('delivery', status)).toBe('pending');
    });

    it('never counts a delivery as a completed pickup, even with a pickup status', () => {
        expect(outcome('delivery', 'picked_up_in_transit')).toBe('pending');
    });
});

describe('classifyStopOutcome of a pickup', () => {
    it.each(['supplier_pickup', 'warehouse_return_pickup'])('is completed once %s was collected', (type) => {
        expect(outcome(type, 'picked_up_in_transit')).toBe('pickup_completed');
        expect(outcome(type, 'returned_to_warehouse')).toBe('pickup_completed');
    });

    it('is unsuccessful when the pickup failed and pending while it is open', () => {
        expect(outcome('supplier_pickup', 'not_delivered')).toBe('unsuccessful');
        expect(outcome('supplier_pickup', 'cancelled')).toBe('unsuccessful');
        expect(outcome('warehouse_return_pickup', 'out_for_delivery')).toBe('pending');
    });

    it('recognizes the pickup types and no other', () => {
        expect(isPickupType('supplier_pickup')).toBe(true);
        expect(isPickupType('warehouse_return_pickup')).toBe(true);
        expect(isPickupType('delivery')).toBe(false);
    });
});

describe('classifyStopOutcome of a stop that did not leave', () => {
    it('is excluded at start whatever its dispatch status is, so it never mixes with a result', () => {
        for (const status of ['assigned', 'delivered', 'cancelled']) {
            expect(outcome('delivery', status, 'excluded')).toBe('excluded_at_start');
        }
        expect(outcome('supplier_pickup', 'assigned', 'excluded')).toBe('excluded_at_start');
    });
});

describe('classifyRemovedBeforeStart', () => {
    it('separates a cancellation from any other way of leaving the route before it started', () => {
        expect(classifyRemovedBeforeStart('cancelled')).toBe('cancelled_before_start');
        expect(classifyRemovedBeforeStart('rescheduled')).toBe('removed_before_start');
        expect(classifyRemovedBeforeStart('pending')).toBe('removed_before_start');
    });
});
