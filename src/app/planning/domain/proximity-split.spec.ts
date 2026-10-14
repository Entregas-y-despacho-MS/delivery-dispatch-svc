import { describe, expect, it } from 'vitest';
import { composeBatches, nearestNeighbourChain, type DurationLookup } from './proximity-split.js';
import { dispatch, vehicle } from './plan-fixtures.helper-spec.js';

/** Points on a line: index 0 is the depot at km 0, index i + 1 is at `kms[i]`. Time = distance. */
function onALine(kms: number[]): DurationLookup {
    const position = [0, ...kms];
    return (from, to) => Math.abs(position[from] - position[to]) * 60;
}

describe('nearestNeighbourChain', () => {
    it('visits the closest unvisited point each time, from the depot', () => {
        const chain = nearestNeighbourChain([1, 2, 3, 4], onALine([4, 1, 3, 2]));
        expect(chain).toEqual([2, 4, 3, 1]);
    });

    it('breaks a tie by the lower index', () => {
        expect(nearestNeighbourChain([1, 2], onALine([3, 3]))).toEqual([1, 2]);
    });

    it('treats an unreachable point as infinitely far and keeps the rest', () => {
        const duration: DurationLookup = (from, to) => (to === 1 ? null : Math.abs(from - to));
        expect(nearestNeighbourChain([1, 2, 3], duration)).toEqual([2, 3, 1]);
    });

    it('keeps the input order when everything is unreachable', () => {
        expect(nearestNeighbourChain([1, 2, 3], () => null)).toEqual([1, 2, 3]);
    });
});

describe('composeBatches', () => {
    const heavy = (id: number, km: number, kg = 60) => dispatch(id, { km, estimatedWeightKg: kg });

    it('puts the whole group in the smallest free vehicle that fits', () => {
        const group = [heavy(1, 1, 10), heavy(2, 2, 10)];
        const result = composeBatches(group, onALine([1, 2]), [vehicle(1, 500), vehicle(2, 100)], [vehicle(1, 500), vehicle(2, 100)], 50);

        expect(result.batches).toHaveLength(1);
        expect(result.batches[0].vehicle.vehicleId).toBe(2);
        expect(result.batches[0].alternativeVehicles.map((v) => v.vehicleId)).toEqual([1]);
        expect(result.batches[0].dispatches.map((d) => d.dispatchId)).toEqual([1, 2]);
        expect(result.splitReason).toBeNull();
    });

    it('divides by proximity when the group fits no vehicle, the first batch holding the head of the queue', () => {
        // Two clusters: 1 km and 2 km, then 20 km and 21 km. 60 kg each, vehicles carry 130 kg.
        const group = [heavy(1, 20), heavy(2, 1), heavy(3, 21), heavy(4, 2)];
        const fleet = [vehicle(1, 130), vehicle(2, 130)];

        const result = composeBatches(group, onALine([20, 1, 21, 2]), fleet, fleet, 50);

        // The queue head (1, at 20 km) starts the first stretch and drags its neighbour (3, at 21 km).
        expect(result.batches.map((b) => b.dispatches.map((d) => d.dispatchId))).toEqual([[1, 3], [2, 4]]);
        expect(result.batches.map((b) => b.vehicle.vehicleId)).toEqual([1, 2]);
        expect(result.splitReason).toBe('capacity');
        expect(result.withoutVehicle).toEqual([]);
    });

    it('reduces each stretch to the smallest vehicle where it fits', () => {
        const group = [heavy(1, 1, 90), heavy(2, 2, 90), heavy(3, 3, 10)];
        const fleet = [vehicle(1, 100), vehicle(2, 200)];

        const result = composeBatches(group, onALine([1, 2, 3]), fleet, fleet, 50);

        // 90 + 90 + 10 = 190 kg fits only the 200 kg vehicle, as one batch.
        expect(result.batches).toHaveLength(1);
        expect(result.batches[0].vehicle.vehicleId).toBe(2);
    });

    it('reports an order that fits no vehicle of the fleet, even alone, and still plans the rest', () => {
        const group = [heavy(1, 1, 10), heavy(2, 2, 5000), heavy(3, 3, 10)];
        const fleet = [vehicle(1, 100)];

        const result = composeBatches(group, onALine([1, 2, 3]), fleet, fleet, 50);

        expect(result.unfittable.map((d) => d.dispatchId)).toEqual([2]);
        expect(result.batches[0].dispatches.map((d) => d.dispatchId)).toEqual([1, 3]);
    });

    it('leaves orders without vehicle when the free vehicles run out', () => {
        const group = [heavy(1, 1), heavy(2, 2), heavy(3, 3)];
        const fleet = [vehicle(1, 70)];

        const result = composeBatches(group, onALine([1, 2, 3]), fleet, fleet, 50);

        expect(result.batches).toHaveLength(1);
        expect(result.batches[0].dispatches.map((d) => d.dispatchId)).toEqual([1]);
        expect(result.withoutVehicle.map((d) => d.dispatchId)).toEqual([2, 3]);
        expect(result.unfittable).toEqual([]);
    });

    it('does not use a vehicle that is not free, but still knows the order would fit it', () => {
        const group = [heavy(1, 1, 300)];
        const fleet = [vehicle(1, 100), vehicle(2, 500)];

        const result = composeBatches(group, onALine([1]), [fleet[0]], fleet, 50);

        expect(result.batches).toEqual([]);
        expect(result.unfittable).toEqual([]);
        expect(result.withoutVehicle.map((d) => d.dispatchId)).toEqual([1]);
    });

    it('splits by the stop limit when capacity would allow one batch, and says so', () => {
        const group = [heavy(1, 1, 5), heavy(2, 2, 5), heavy(3, 3, 5), heavy(4, 4, 5), heavy(5, 5, 5)];
        const fleet = [vehicle(1, 1000), vehicle(2, 1000), vehicle(3, 1000)];

        const result = composeBatches(group, onALine([1, 2, 3, 4, 5]), fleet, fleet, 2);

        expect(result.batches.map((b) => b.dispatches.length)).toEqual([2, 2, 1]);
        expect(result.splitReason).toBe('table_limit');
    });

    it('never puts more stops than the limit in a batch', () => {
        const group = Array.from({ length: 7 }, (_, i) => heavy(i + 1, i + 1, 1));
        const fleet = Array.from({ length: 4 }, (_, i) => vehicle(i + 1, 1000));

        const result = composeBatches(group, onALine(group.map((_, i) => i + 1)), fleet, fleet, 3);

        expect(Math.max(...result.batches.map((b) => b.dispatches.length))).toBe(3);
        expect(result.batches.flatMap((b) => b.dispatches)).toHaveLength(7);
    });
});
