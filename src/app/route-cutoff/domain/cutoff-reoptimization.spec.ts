import { describe, expect, it } from 'vitest';
import { vehicle } from '../../planning/domain/plan-fixtures.helper-spec.js';
import { batch, cutoffInput, NOTIFIED_TODAY, stop } from './cutoff-fixtures.helper-spec.js';
import { reoptimizeCutoff } from './cutoff-reoptimization.js';

const ids = (b: { stops: Array<{ dispatchId: number }> }) => b.stops.map((s) => s.dispatchId);

describe('reoptimizeCutoff — merge', () => {
    it('merges two small batches of the same zone and day without moving any slot', () => {
        const a = batch(1, [stop(1, { window: ['09:00', '11:00'] }), stop(2, { window: ['11:00', '13:00'] })]);
        const b = batch(2, [stop(3, { window: ['14:00', '16:00'] })]);
        const plan = reoptimizeCutoff(cutoffInput([a, b]));

        expect(plan.batches).toHaveLength(1);
        expect(plan.batches[0].routeBatchId).toBe(1);
        expect(ids(plan.batches[0])).toEqual([1, 2, 3]);
        expect(plan.batches[0].absorbedBatchIds).toEqual([2]);
        expect(plan.cancelledBatchIds).toEqual([2]);
        expect(plan.movements).toEqual([
            { kind: 'merged', fromBatchId: 2, toBatchId: 1, toNewRef: null, dispatchIds: [3] },
        ]);
    });

    it('does not merge when the union would push a promised slot out of its window', () => {
        // Both customers were promised 09:00-09:30: no single route can serve the two.
        const a = batch(1, [stop(1, { km: 1, window: ['09:00', '09:30'] })]);
        const b = batch(2, [stop(2, { km: 30, window: ['09:00', '09:30'] })]);
        const plan = reoptimizeCutoff(cutoffInput([a, b]));

        expect(plan.batches.map((p) => p.routeBatchId)).toEqual([1, 2]);
        expect(plan.movements).toEqual([]);
        expect(plan.cancelledBatchIds).toEqual([]);
    });

    it('never merges batches of different zones', () => {
        const a = batch(1, [stop(1)], { zoneId: 1 });
        const b = batch(2, [stop(2, { window: ['11:00', '13:00'] })], { zoneId: 2, zoneCode: 'ZON-2' });
        const plan = reoptimizeCutoff(cutoffInput([a, b]));

        expect(plan.batches.map((p) => p.routeBatchId)).toEqual([1, 2]);
        expect(plan.movements).toEqual([]);
    });

    it('does not merge when the union exceeds the stops a table request allows', () => {
        const a = batch(1, [stop(1), stop(2, { window: ['11:00', '13:00'] })]);
        const b = batch(2, [stop(3, { window: ['14:00', '16:00'] })]);
        const plan = reoptimizeCutoff(cutoffInput([a, b], { maxStopsPerBatch: 2 }));

        expect(plan.batches).toHaveLength(2);
    });

    it('frees the vehicle of the absorbed batch and picks the smallest that fits', () => {
        const a = batch(1, [stop(1, { kg: 40 })], { vehicleId: 1 });
        const b = batch(2, [stop(2, { kg: 40, window: ['11:00', '13:00'] })], { vehicleId: 2 });
        const plan = reoptimizeCutoff(cutoffInput([a, b], {}, [vehicle(1, 1000), vehicle(2, 100), vehicle(3, 50)]));

        expect(plan.batches).toHaveLength(1);
        expect(plan.batches[0].vehicleId).toBe(2);
    });
});

describe('reoptimizeCutoff — split and move', () => {
    it('divides a batch that no longer fits its vehicle into a new batch with a free one', () => {
        const a = batch(1, [stop(1, { kg: 60 }), stop(2, { kg: 60, window: ['11:00', '13:00'] })], { vehicleId: 1 });
        const plan = reoptimizeCutoff(cutoffInput([a], {}, [vehicle(1, 100), vehicle(2, 100)]));

        expect(plan.batches).toHaveLength(2);
        const [kept, created] = plan.batches;
        expect(ids(kept)).toEqual([1]);
        expect(kept.routeBatchId).toBe(1);
        expect(ids(created)).toEqual([2]);
        expect(created.routeBatchId).toBeNull();
        expect(created.vehicleId).toBe(2);
        expect(created.splitFromBatchId).toBe(1);
        expect(plan.movements).toEqual([
            { kind: 'split', fromBatchId: 1, toBatchId: null, toNewRef: created.newRef, dispatchIds: [2] },
        ]);
    });

    it('moves the extra stop to another batch of the zone when it takes it', () => {
        const a = batch(1, [stop(1, { kg: 60 }), stop(2, { kg: 60, window: ['11:00', '13:00'] })], { vehicleId: 1 });
        const b = batch(2, [stop(3, { kg: 10, window: ['14:00', '16:00'] })], { vehicleId: 2 });
        // maxStopsPerBatch 2: the union of three stops is not a merge, but one stop may change batch.
        const plan = reoptimizeCutoff(cutoffInput([a, b], { maxStopsPerBatch: 2 }, [vehicle(1, 100), vehicle(2, 1000)]));

        expect(plan.batches).toHaveLength(2);
        expect(ids(plan.batches.find((p) => p.routeBatchId === 1)!)).toEqual([1]);
        expect(ids(plan.batches.find((p) => p.routeBatchId === 2)!)).toEqual([2, 3]);
        expect(plan.movements).toEqual([
            { kind: 'moved', fromBatchId: 1, toBatchId: 2, toNewRef: null, dispatchIds: [2] },
        ]);
    });

    it('marks the batch incomplete when no vehicle is left for the extra stop', () => {
        const a = batch(1, [stop(1, { kg: 60 }), stop(2, { kg: 60, window: ['11:00', '13:00'] })], { vehicleId: 1 });
        const plan = reoptimizeCutoff(cutoffInput([a], {}, [vehicle(1, 100)]));

        expect(plan.batches).toHaveLength(1);
        expect(ids(plan.batches[0])).toEqual([1, 2]);
        expect(plan.batches[0].reoptimizationIncomplete).toBe(true);
    });

    it('keeps each stop with the slot it was promised', () => {
        const a = batch(1, [stop(1, { window: ['11:00', '13:00'] }), stop(2, { window: ['09:00', '11:00'] })]);
        const plan = reoptimizeCutoff(cutoffInput([a]));

        // Visiting order follows the slots; the plan only carries the order, never a new window.
        expect(ids(plan.batches[0])).toEqual([2, 1]);
        expect(plan.batches[0].stops.map((s) => s.sequence)).toEqual([1, 2]);
    });
});

describe('reoptimizeCutoff — what stays out of the cutoff', () => {
    it('leaves a stop with an open window in a remnant of the same batch zone and day', () => {
        const a = batch(1, [stop(1), stop(2, { notifiedAt: NOTIFIED_TODAY, window: ['11:00', '13:00'] })]);
        const plan = reoptimizeCutoff(cutoffInput([a]));

        expect(plan.batches).toHaveLength(1);
        expect(ids(plan.batches[0])).toEqual([1]);
        expect(plan.remnants).toEqual([
            {
                sourceBatchId: 1,
                shiftDate: '2026-10-14',
                zoneId: 1,
                zoneCode: 'ZON-1',
                zoneName: 'Zona 1',
                warehouseId: 1,
                reviewerUserId: 7,
                dispatchIds: [2],
            },
        ]);
    });

    it('releases an order that was never approved', () => {
        const a = batch(1, [stop(1), stop(2, { status: 'in_planning' })]);
        const plan = reoptimizeCutoff(cutoffInput([a]));

        expect(ids(plan.batches[0])).toEqual([1]);
        expect(plan.released).toEqual([{ dispatchId: 2, fromBatchId: 1, reason: 'no_promise' }]);
    });

    it('does not process a batch with no firm stop at all', () => {
        const a = batch(1, [stop(1, { notifiedAt: NOTIFIED_TODAY })]);
        const plan = reoptimizeCutoff(cutoffInput([a]));

        expect(plan.batches).toEqual([]);
        expect(plan.untouched).toEqual([{ routeBatchId: 1, openDispatchIds: [1] }]);
    });

    it('cancels a batch that only had orders without promise and returns its vehicle', () => {
        const a = batch(1, [stop(1, { status: 'in_planning' })], { vehicleId: 1 });
        const b = batch(2, [stop(2, { kg: 60 }), stop(3, { kg: 60, window: ['11:00', '13:00'] })], { vehicleId: 2, zoneId: 2, zoneCode: 'ZON-2' });
        const plan = reoptimizeCutoff(cutoffInput([a, b], {}, [vehicle(1, 100), vehicle(2, 100)]));

        expect(plan.cancelledBatchIds).toEqual([1]);
        expect(plan.released).toEqual([{ dispatchId: 1, fromBatchId: 1, reason: 'no_promise' }]);
        // The vehicle of the cancelled batch is the one the divided batch of the other zone gets.
        expect(plan.batches.find((p) => p.routeBatchId === null)!.vehicleId).toBe(1);
    });
});
