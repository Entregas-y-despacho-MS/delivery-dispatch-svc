/**
 * Reoptimization of the provisional batches at the D-1 cutoff (ST-51.3, D-11). Pure.
 *
 * Inside the promises: every stop that enters the cutoff keeps the day and the slot its customer was
 * told, so the slot is a fixed window for the route simulation. Within one group (day, zone and
 * warehouse) the batches are merged when the union still fits one vehicle and every window holds, and
 * a batch that no longer fits is divided: its extra stops move to another batch of the group, or to a
 * new one with a free vehicle. A zone is never crossed (D-06).
 *
 * Stops that never entered stay behind: those with an open window wait in a remnant batch, those
 * without promise are released (`pending`). Nothing here writes; the proposal is applied by the writer.
 */
import { sequenceByInsertion } from '../../planning/domain/insertion.js';
import type { PlanVehicle } from '../../planning/domain/plan-types.js';
import type { SimParams, SimStop } from '../../planning/domain/route-simulation.js';
import { bySmallestVehicle, fitsVehicle, smallestFittingVehicle } from '../../planning/domain/vehicle-selection.js';
import { toLocalMoment } from '../../scheduler/domain/task-schedule.js';
import { partitionStops } from './cutoff-eligibility.js';
import { buildSimParams } from './cutoff-sim-params.js';
import type {
    CutoffBatch,
    CutoffBatchPlan,
    CutoffInput,
    CutoffMovement,
    CutoffMovementKind,
    CutoffPlan,
    CutoffRelease,
    CutoffRemnant,
    CutoffStop,
    CutoffUntouchedBatch,
} from './cutoff-types.js';

/** A batch while it is being reshaped. */
interface Work {
    routeBatchId: number | null;
    newRef: string | null;
    template: CutoffBatch;
    expectedVersion: number | null;
    proposedDriverId: number | null;
    stops: CutoffStop[];
    open: CutoffStop[];
    vehicleId: number | null;
    absorbed: number[];
    splitFrom: number | null;
    incomplete: boolean;
}

function minuteOf(instant: Date): number {
    return toLocalMoment(instant).minuteOfDay;
}

/** The slot promised to the customer is a fixed window: it never moves (D-11). */
function toSimStop(stop: CutoffStop): SimStop {
    return {
        id: stop.dispatch.dispatchId,
        fixedWindow: stop.window
            ? { startMinute: minuteOf(stop.window.start), endMinute: minuteOf(stop.window.end) }
            : null,
    };
}

interface Sequenced {
    ordered: CutoffStop[];
    rejected: CutoffStop[];
    ok: boolean;
}

function sequence(stops: CutoffStop[], params: SimParams): Sequenced {
    const byId = new Map(stops.map((stop) => [stop.dispatch.dispatchId, stop]));
    // Earliest promised slot first, then the order the batch already had: a stable offer order.
    const offered = [...stops]
        .sort((a, b) => windowStart(a) - windowStart(b) || a.sequence - b.sequence)
        .map(toSimStop);
    const result = sequenceByInsertion(offered, params);
    return {
        ordered: result.sequence.map((stop) => byId.get(stop.id)!),
        rejected: result.rejected.map((stop) => byId.get(stop.id)!),
        ok: result.rejected.length === 0 && result.simulation.feasible,
    };
}

function windowStart(stop: CutoffStop): number {
    return stop.window ? minuteOf(stop.window.start) : Number.MAX_SAFE_INTEGER;
}

function fits(stops: CutoffStop[], vehicle: PlanVehicle): boolean {
    return fitsVehicle(stops.map((stop) => stop.dispatch), vehicle);
}

export function reoptimizeCutoff(input: CutoffInput): CutoffPlan {
    const { settings } = input;
    const windowMinutes = settings.promiseRules.promiseResponseWindowMinutes;
    const fleet = new Map(input.fleet.map((vehicle) => [vehicle.vehicleId, vehicle]));

    // Free vehicles: active, not held by a batch outside the cutoff and not by a batch being processed.
    const held = new Set<number>(input.occupiedVehicleIds);
    for (const batch of input.batches) if (batch.vehicleId !== null) held.add(batch.vehicleId);
    const free: PlanVehicle[] = input.fleet.filter((vehicle) => !held.has(vehicle.vehicleId));

    const plan: CutoffPlan = { batches: [], remnants: [], untouched: [], released: [], movements: [], cancelledBatchIds: [] };
    const movements = new Map<string, CutoffMovement>();
    let newCounter = 0;

    const groups = new Map<string, CutoffBatch[]>();
    for (const batch of input.batches) {
        const key = `${batch.shiftDate}|${batch.zoneId}|${batch.warehouseId}`;
        groups.set(key, [...(groups.get(key) ?? []), batch]);
    }

    const giveBack = (vehicleId: number | null, except: number | null): void => {
        if (vehicleId === null || vehicleId === except) return;
        const vehicle = fleet.get(vehicleId);
        if (vehicle && !free.some((candidate) => candidate.vehicleId === vehicleId)) free.push(vehicle);
    };
    const take = (vehicleId: number): void => {
        const index = free.findIndex((candidate) => candidate.vehicleId === vehicleId);
        if (index >= 0) free.splice(index, 1);
    };
    const record = (kind: CutoffMovementKind, fromBatchId: number, to: Work, dispatchIds: number[]): void => {
        const key = `${kind}|${fromBatchId}|${to.routeBatchId ?? to.newRef}`;
        const existing = movements.get(key);
        if (existing) existing.dispatchIds.push(...dispatchIds);
        else {
            movements.set(key, {
                kind,
                fromBatchId,
                toBatchId: to.routeBatchId,
                toNewRef: to.routeBatchId === null ? to.newRef : null,
                dispatchIds: [...dispatchIds],
            });
        }
    };

    for (const batches of groups.values()) {
        const [first] = batches;
        const params: SimParams = buildSimParams(settings, input.travelFor(first.warehouseId, first.zoneId));

        const works: Work[] = [];
        for (const batch of batches) {
            const part = partitionStops(batch.stops, input.now, windowMinutes);
            for (const stop of part.withoutPromise) {
                plan.released.push({ dispatchId: stop.dispatch.dispatchId, fromBatchId: batch.routeBatchId, reason: 'no_promise' } satisfies CutoffRelease);
            }
            if (part.eligible.length === 0) {
                if (part.open.length > 0) {
                    plan.untouched.push({ routeBatchId: batch.routeBatchId, openDispatchIds: part.open.map((s) => s.dispatch.dispatchId) } satisfies CutoffUntouchedBatch);
                } else {
                    plan.cancelledBatchIds.push(batch.routeBatchId);
                    giveBack(batch.vehicleId, null);
                }
                continue;
            }
            works.push({
                routeBatchId: batch.routeBatchId,
                newRef: null,
                template: batch,
                expectedVersion: batch.version,
                proposedDriverId: batch.proposedDriverId,
                stops: part.eligible,
                open: part.open,
                vehicleId: batch.vehicleId !== null && fleet.has(batch.vehicleId) ? batch.vehicleId : null,
                absorbed: [],
                splitFrom: null,
                incomplete: false,
            });
        }

        // Keeps the batch's own vehicle while it fits; otherwise the smallest one of the pool where it does.
        const adopt = (work: Work, stops: CutoffStop[], pool: PlanVehicle[]): void => {
            const own = work.vehicleId !== null ? fleet.get(work.vehicleId) : undefined;
            if (own && fits(stops, own)) return;
            const vehicle = smallestFittingVehicle(stops.map((s) => s.dispatch), pool);
            if (!vehicle) return;
            giveBack(work.vehicleId, vehicle.vehicleId);
            take(vehicle.vehicleId);
            work.vehicleId = vehicle.vehicleId;
        };

        const ownVehicle = (work: Work): PlanVehicle[] => {
            const vehicle = work.vehicleId !== null ? fleet.get(work.vehicleId) : undefined;
            return vehicle ? [vehicle] : [];
        };

        // 1. Merge: the smallest batch into one that can take it without breaking a slot.
        let merged = true;
        while (merged && works.length > 1) {
            merged = false;
            const bySize = [...works].sort((a, b) => a.stops.length - b.stops.length);
            search: for (const small of bySize) {
                for (const target of [...works].sort((a, b) => b.stops.length - a.stops.length)) {
                    if (target === small) continue;
                    const combined = [...target.stops, ...small.stops];
                    if (combined.length > input.maxStopsPerBatch) continue;
                    const sequenced = sequence(combined, params);
                    if (!sequenced.ok) continue;
                    const pool = [...ownVehicle(target), ...ownVehicle(small), ...free];
                    const vehicle = smallestFittingVehicle(combined.map((s) => s.dispatch), pool);
                    if (!vehicle) continue;

                    giveBack(target.vehicleId, vehicle.vehicleId);
                    giveBack(small.vehicleId, vehicle.vehicleId);
                    take(vehicle.vehicleId);
                    record('merged', small.routeBatchId!, target, small.stops.map((s) => s.dispatch.dispatchId));
                    target.stops = sequenced.ordered;
                    target.open = [...target.open, ...small.open];
                    target.vehicleId = vehicle.vehicleId;
                    target.absorbed.push(small.routeBatchId!, ...small.absorbed);
                    works.splice(works.indexOf(small), 1);
                    merged = true;
                    break search;
                }
            }
        }

        // 2. Repair: a batch that no longer fits sheds stops to another batch or to a new one.
        for (let index = 0; index < works.length; index++) {
            const work = works[index];
            for (let guard = 0; guard < 100; guard++) {
                const sequenced = sequence(work.stops, params);
                const pool = [...ownVehicle(work), ...free];
                const largest = [...pool].sort(bySmallestVehicle).at(-1) ?? null;

                let kept = [...sequenced.ordered];
                const evicted: CutoffStop[] = [...sequenced.rejected];
                while (kept.length > 1 && (kept.length > input.maxStopsPerBatch || (largest !== null && !fits(kept, largest)))) {
                    evicted.unshift(kept.pop()!);
                }
                if (evicted.length === 0 || kept.length === 0) {
                    work.incomplete = !sequenced.ok || largest === null || !fits(kept.length ? kept : work.stops, largest);
                    if (!work.incomplete) {
                        work.stops = sequenced.ordered;
                        adopt(work, work.stops, pool);
                    }
                    break;
                }

                // Where do the evicted stops go: first another batch of the group, then a new one.
                const remaining: CutoffStop[] = [];
                for (const stop of evicted) {
                    const home = works.find((other) => {
                        if (other === work) return false;
                        const combined = [...other.stops, stop];
                        if (combined.length > input.maxStopsPerBatch || !sequence(combined, params).ok) return false;
                        return smallestFittingVehicle(combined.map((s) => s.dispatch), [...ownVehicle(other), ...free]) !== null;
                    });
                    if (!home) {
                        remaining.push(stop);
                        continue;
                    }
                    const combined = [...home.stops, stop];
                    const vehicle = smallestFittingVehicle(combined.map((s) => s.dispatch), [...ownVehicle(home), ...free])!;
                    giveBack(home.vehicleId, vehicle.vehicleId);
                    take(vehicle.vehicleId);
                    home.vehicleId = vehicle.vehicleId;
                    home.stops = sequence(combined, params).ordered;
                    record('moved', work.routeBatchId ?? work.splitFrom!, home, [stop.dispatch.dispatchId]);
                }

                if (remaining.length > 0) {
                    const vehicle = smallestFittingVehicle(remaining.map((s) => s.dispatch), free)
                        ?? smallestFittingVehicle([remaining[0].dispatch], free);
                    if (!vehicle) {
                        // No vehicle left: the stops stay and the validator reports why.
                        work.incomplete = true;
                        work.stops = sequenced.ordered;
                        break;
                    }
                    take(vehicle.vehicleId);
                    const created: Work = {
                        routeBatchId: null,
                        newRef: `new-${++newCounter}`,
                        template: work.template,
                        expectedVersion: null,
                        proposedDriverId: null,
                        stops: remaining,
                        open: [],
                        vehicleId: vehicle.vehicleId,
                        absorbed: [],
                        splitFrom: work.routeBatchId ?? work.splitFrom,
                        incomplete: false,
                    };
                    works.push(created);
                    record('split', work.routeBatchId ?? work.splitFrom!, created, remaining.map((s) => s.dispatch.dispatchId));
                }

                work.stops = kept;
                adopt(work, kept, pool);
            }
        }

        for (const work of works) {
            const sequenced = sequence(work.stops, params);
            const ordered = sequenced.ok
                ? sequenced.ordered
                : [...work.stops].sort((a, b) => a.sequence - b.sequence);
            plan.batches.push(toBatchPlan(work, ordered));
            for (const id of work.absorbed) plan.cancelledBatchIds.push(id);
            if (work.open.length > 0 && work.routeBatchId !== null) {
                plan.remnants.push(toRemnant(work));
            }
        }
    }

    plan.movements = [...movements.values()];
    return plan;
}

function toBatchPlan(work: Work, ordered: CutoffStop[]): CutoffBatchPlan {
    const { template } = work;
    return {
        routeBatchId: work.routeBatchId,
        newRef: work.newRef,
        expectedVersion: work.expectedVersion,
        shiftDate: template.shiftDate,
        zoneId: template.zoneId,
        zoneCode: template.zoneCode,
        zoneName: template.zoneName,
        warehouseId: template.warehouseId,
        vehicleId: work.vehicleId,
        proposedDriverId: work.proposedDriverId,
        reviewerUserId: template.reviewerUserId,
        stops: ordered.map((stop, i) => ({ dispatchId: stop.dispatch.dispatchId, sequence: i + 1, version: stop.version })),
        absorbedBatchIds: work.absorbed,
        splitFromBatchId: work.splitFrom,
        reoptimizationIncomplete: work.incomplete,
    };
}

function toRemnant(work: Work): CutoffRemnant {
    const { template } = work;
    return {
        sourceBatchId: work.routeBatchId!,
        shiftDate: template.shiftDate,
        zoneId: template.zoneId,
        zoneCode: template.zoneCode,
        zoneName: template.zoneName,
        warehouseId: template.warehouseId,
        reviewerUserId: template.reviewerUserId,
        dispatchIds: work.open.map((stop) => stop.dispatch.dispatchId),
    };
}
