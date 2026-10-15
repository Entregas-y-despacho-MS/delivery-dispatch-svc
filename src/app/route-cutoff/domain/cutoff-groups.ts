/**
 * Cuts a cutoff proposal into the groups it was computed over (day, zone and warehouse, ST-51.3).
 * A group is the unit of persistence: merges, splits and moves only ever happen inside one, and the
 * vehicles they hand around are written together in one transaction (the unique indexes of vehicle
 * and driver per day are not deferrable).
 */
import type { CutoffBatch, CutoffPlan } from './cutoff-types.js';

export interface CutoffGroup {
    key: string;
    shiftDate: string;
    zoneId: number;
    warehouseId: number;
    /** The provisional batches the group was read with (the ones the writer locks). */
    batchIds: number[];
    plan: CutoffPlan;
}

export function groupKey(batch: { shiftDate: string; zoneId: number; warehouseId: number }): string {
    return `${batch.shiftDate}|${batch.zoneId}|${batch.warehouseId}`;
}

const emptyPlan = (): CutoffPlan => ({ batches: [], remnants: [], untouched: [], released: [], movements: [], cancelledBatchIds: [] });

export function splitPlanByGroup(plan: CutoffPlan, batches: CutoffBatch[]): CutoffGroup[] {
    const keyOfBatch = new Map(batches.map((batch) => [batch.routeBatchId, groupKey(batch)]));
    const groups = new Map<string, CutoffGroup>();

    for (const batch of batches) {
        const key = groupKey(batch);
        if (!groups.has(key)) {
            groups.set(key, {
                key,
                shiftDate: batch.shiftDate,
                zoneId: batch.zoneId,
                warehouseId: batch.warehouseId,
                batchIds: [],
                plan: emptyPlan(),
            });
        }
        groups.get(key)!.batchIds.push(batch.routeBatchId);
    }

    const of = (batchId: number): CutoffGroup => {
        const key = keyOfBatch.get(batchId);
        const group = key === undefined ? undefined : groups.get(key);
        if (!group) throw new Error(`Batch ${batchId} is not part of the cutoff input.`);
        return group;
    };

    for (const batch of plan.batches) groups.get(groupKey(batch))!.plan.batches.push(batch);
    for (const remnant of plan.remnants) of(remnant.sourceBatchId).plan.remnants.push(remnant);
    for (const untouched of plan.untouched) of(untouched.routeBatchId).plan.untouched.push(untouched);
    for (const release of plan.released) of(release.fromBatchId).plan.released.push(release);
    for (const movement of plan.movements) of(movement.fromBatchId).plan.movements.push(movement);
    for (const batchId of plan.cancelledBatchIds) of(batchId).plan.cancelledBatchIds.push(batchId);

    return [...groups.values()];
}
