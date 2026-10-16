import { describe, expect, it } from 'vitest';
import { vehicle } from '../../planning/domain/plan-fixtures.helper-spec.js';
import { batch, cutoffInput, NOTIFIED_TODAY, stop } from './cutoff-fixtures.helper-spec.js';
import { splitPlanByGroup } from './cutoff-groups.js';
import { reoptimizeCutoff } from './cutoff-reoptimization.js';

describe('splitPlanByGroup', () => {
    it('keeps merges, releases and remnants inside the group of the batch they come from', () => {
        const a = batch(1, [stop(1), stop(2, { window: ['11:00', '13:00'], notifiedAt: NOTIFIED_TODAY })], { zoneId: 1 });
        const b = batch(2, [stop(3, { window: ['14:00', '16:00'] })], { zoneId: 1 });
        const c = batch(3, [stop(4), stop(5, { status: 'in_planning' })], { zoneId: 2, zoneCode: 'ZON-2' });
        const input = cutoffInput([a, b, c]);

        const groups = splitPlanByGroup(reoptimizeCutoff(input), input.batches);

        expect(groups.map((g) => g.zoneId)).toEqual([1, 2]);
        const [first, second] = groups;
        expect(first.batchIds).toEqual([1, 2]);
        expect(first.plan.movements.map((m) => m.kind)).toEqual(['merged']);
        // Equal sizes: the first batch is the one absorbed, and its open stop travels with the survivor.
        expect(first.plan.cancelledBatchIds).toEqual([1]);
        expect(first.plan.remnants.map((r) => r.sourceBatchId)).toEqual([2]);
        expect(first.plan.remnants.map((r) => r.dispatchIds)).toEqual([[2]]);
        expect(second.batchIds).toEqual([3]);
        expect(second.plan.released).toEqual([{ dispatchId: 5, fromBatchId: 3, reason: 'no_promise' }]);
    });

    it('puts a batch born by splitting in the group of its source', () => {
        const a = batch(1, [stop(1, { kg: 60 }), stop(2, { kg: 60, window: ['11:00', '13:00'] })], { vehicleId: 1 });
        const input = cutoffInput([a], {}, [vehicle(1, 100), vehicle(2, 100)]);

        const [group] = splitPlanByGroup(reoptimizeCutoff(input), input.batches);

        expect(group.plan.batches).toHaveLength(2);
        expect(group.plan.batches[1].routeBatchId).toBeNull();
    });

    it('fails loudly if the proposal mentions a batch it was not computed from', () => {
        const input = cutoffInput([batch(1, [stop(1)])]);
        const plan = reoptimizeCutoff(input);
        plan.cancelledBatchIds.push(999);
        expect(() => splitPlanByGroup(plan, input.batches)).toThrow(/999/);
    });
});
