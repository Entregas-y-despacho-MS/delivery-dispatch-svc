import { describe, expect, it } from 'vitest';
import {
    currentConditions,
    normalizeConditions,
    planShipmentChange,
    toPackageSnapshot,
    type DispatchPackageSnapshot,
    type ShipmentDispatchSnapshot,
} from './shipment-change.rules.js';

const PKG_1 = { packageId: 'PKG-1', lengthCm: 40, widthCm: 30, heightCm: 25, grossWeightKg: 6.4 };
const PKG_2 = { packageId: 'PKG-2', lengthCm: 10, widthCm: 10, heightCm: 10, grossWeightKg: 1 };

function stored(item: typeof PKG_1, handlingConditions: string[] = ['FRAGILE']): DispatchPackageSnapshot {
    return { ...item, handlingConditions };
}

function dispatch(overrides: Partial<ShipmentDispatchSnapshot> = {}): ShipmentDispatchSnapshot {
    return {
        dispatchId: 7,
        status: 'pending',
        routeBatchId: null,
        evidencePolicy: 'hand_delivery_standard',
        packageReadyAt: null,
        packages: [stored(PKG_1)],
        ...overrides,
    };
}

describe('planShipmentChange — no difference', () => {
    it('does nothing when the same packages are sent again', () => {
        const plan = planShipmentChange(dispatch(), { packages: [PKG_1], handlingConditions: ['FRAGILE'] });

        expect(plan).toEqual({ kind: 'noop' });
    });

    it('does nothing when only the order of the packages differs', () => {
        const snapshot = dispatch({ packages: [stored(PKG_1), stored(PKG_2)] });

        const plan = planShipmentChange(snapshot, { packages: [PKG_2, PKG_1], handlingConditions: ['FRAGILE'] });

        expect(plan).toEqual({ kind: 'noop' });
    });

    it('does nothing when conditions differ only in order or repetition', () => {
        const snapshot = dispatch({ packages: [stored(PKG_1, ['FRAGILE', 'KEEP_UPRIGHT'])] });

        const plan = planShipmentChange(snapshot, {
            packages: [PKG_1],
            handlingConditions: ['KEEP_UPRIGHT', 'FRAGILE', 'FRAGILE'],
        });

        expect(plan).toEqual({ kind: 'noop' });
    });

    it('does not mistake extra decimals beyond the column scale for a change', () => {
        const plan = planShipmentChange(dispatch(), {
            packages: [{ ...PKG_1, lengthCm: 40.001, grossWeightKg: 6.4001 }],
            handlingConditions: ['FRAGILE'],
        });

        expect(plan).toEqual({ kind: 'noop' });
    });

    it('does nothing when the evidence policy is the one the dispatch already has', () => {
        const plan = planShipmentChange(dispatch(), { evidencePolicy: 'hand_delivery_standard' });

        expect(plan).toEqual({ kind: 'noop' });
    });

    it('does nothing for a block that is absent', () => {
        expect(planShipmentChange(dispatch(), {})).toEqual({ kind: 'noop' });
    });

    it('does not fill package_ready_at again, and physicallyPacked false never clears it', () => {
        const packed = dispatch({ packageReadyAt: new Date('2026-10-12T10:00:00Z') });

        expect(planShipmentChange(packed, { physicallyPacked: true })).toEqual({ kind: 'noop' });
        expect(planShipmentChange(packed, { physicallyPacked: false })).toEqual({ kind: 'noop' });
        expect(planShipmentChange(dispatch(), { physicallyPacked: false })).toEqual({ kind: 'noop' });
    });

    it('keeps a dispatch in its proposed batch when nothing changed', () => {
        const plan = planShipmentChange(dispatch({ status: 'in_planning', routeBatchId: 4 }), {
            packages: [PKG_1],
            handlingConditions: ['FRAGILE'],
        });

        expect(plan).toEqual({ kind: 'noop' });
    });

    it('treats an empty list of packages as no change to the packages', () => {
        expect(planShipmentChange(dispatch(), { packages: [] })).toEqual({ kind: 'noop' });
    });
});

describe('planShipmentChange — editable dispatches', () => {
    it('replaces the whole list when a package changes its measures or weight', () => {
        const plan = planShipmentChange(dispatch(), {
            packages: [{ ...PKG_1, widthCm: 35, grossWeightKg: 7.2 }],
            handlingConditions: ['FRAGILE'],
        });

        expect(plan.kind).toBe('update');
        if (plan.kind !== 'update') return;
        expect(plan.packages).toEqual([
            { packageId: 'PKG-1', lengthCm: 40, widthCm: 35, heightCm: 25, grossWeightKg: 7.2, handlingConditions: ['FRAGILE'] },
        ]);
        expect(plan.changedBlocks).toEqual(['packages']);
        expect(plan.diff.packages?.from).toEqual([stored(PKG_1)]);
        expect(plan.removeFromProposal).toBe(false);
        expect(plan.evidencePolicy).toBeNull();
    });

    it('adds and removes packages as the new list says', () => {
        const added = planShipmentChange(dispatch(), { packages: [PKG_1, PKG_2], handlingConditions: ['FRAGILE'] });
        const removed = planShipmentChange(dispatch({ packages: [stored(PKG_1), stored(PKG_2)] }), {
            packages: [PKG_2],
            handlingConditions: ['FRAGILE'],
        });

        expect(added.kind === 'update' && added.packages?.map((item) => item.packageId)).toEqual(['PKG-1', 'PKG-2']);
        expect(removed.kind === 'update' && removed.packages?.map((item) => item.packageId)).toEqual(['PKG-2']);
    });

    it('keeps the conditions of the dispatch when the packages come without handlingConditions', () => {
        const plan = planShipmentChange(dispatch(), { packages: [{ ...PKG_1, grossWeightKg: 9 }] });

        expect(plan.kind).toBe('update');
        if (plan.kind !== 'update') return;
        expect(plan.packages?.[0].handlingConditions).toEqual(['FRAGILE']);
        expect(plan.changedBlocks).toEqual(['packages']);
    });

    it('applies new handling conditions to every package of the dispatch', () => {
        const snapshot = dispatch({ packages: [stored(PKG_1), stored(PKG_2)] });

        const plan = planShipmentChange(snapshot, { handlingConditions: ['FRAGILE', 'KEEP_UPRIGHT'] });

        expect(plan.kind).toBe('update');
        if (plan.kind !== 'update') return;
        expect(plan.changedBlocks).toEqual(['handlingConditions']);
        expect(plan.packages?.every((item) => item.handlingConditions.join() === 'FRAGILE,KEEP_UPRIGHT')).toBe(true);
        expect(plan.diff.handlingConditions).toEqual({ from: ['FRAGILE'], to: ['FRAGILE', 'KEEP_UPRIGHT'] });
    });

    it('changes the evidence policy alone, without touching the packages', () => {
        const plan = planShipmentChange(dispatch(), { evidencePolicy: 'high_value_control' });

        expect(plan.kind).toBe('update');
        if (plan.kind !== 'update') return;
        expect(plan.packages).toBeNull();
        expect(plan.evidencePolicy).toBe('high_value_control');
        expect(plan.changedBlocks).toEqual(['evidencePolicy']);
        expect(plan.diff.evidencePolicy).toEqual({ from: 'hand_delivery_standard', to: 'high_value_control' });
    });

    it('fills package_ready_at once when the shipment becomes physically packed', () => {
        const plan = planShipmentChange(dispatch(), { physicallyPacked: true });

        expect(plan.kind).toBe('update');
        if (plan.kind !== 'update') return;
        expect(plan.fillPackageReadyAt).toBe(true);
        expect(plan.changedBlocks).toEqual(['physicallyPacked']);
        expect(plan.packages).toBeNull();
    });

    it('applies several blocks of the same message together', () => {
        const plan = planShipmentChange(dispatch(), {
            packages: [PKG_1, PKG_2],
            handlingConditions: ['FRAGILE'],
            evidencePolicy: 'contactless_delivery',
            physicallyPacked: true,
        });

        expect(plan.kind).toBe('update');
        if (plan.kind !== 'update') return;
        expect(plan.changedBlocks).toEqual(['packages', 'evidencePolicy', 'physicallyPacked']);
    });

    it('last one wins when the same packageId comes twice', () => {
        const plan = planShipmentChange(dispatch(), {
            packages: [PKG_1, { ...PKG_1, grossWeightKg: 8 }],
            handlingConditions: ['FRAGILE'],
        });

        expect(plan.kind).toBe('update');
        if (plan.kind !== 'update') return;
        expect(plan.packages).toHaveLength(1);
        expect(plan.packages?.[0].grossWeightKg).toBe(8);
    });

    it('applies the change to a pending or address_review dispatch without leaving any batch', () => {
        for (const status of ['pending', 'address_review']) {
            const plan = planShipmentChange(dispatch({ status }), { packages: [{ ...PKG_1, grossWeightKg: 9 }] });

            expect(plan).toMatchObject({ kind: 'update', removeFromProposal: false, statusAfter: status });
        }
    });
});

describe('planShipmentChange — proposed batch', () => {
    it('takes an in_planning dispatch out of its batch when the packages change, and returns it to pending', () => {
        const plan = planShipmentChange(dispatch({ status: 'in_planning', routeBatchId: 4 }), {
            packages: [{ ...PKG_1, grossWeightKg: 9 }],
            handlingConditions: ['FRAGILE'],
        });

        expect(plan).toMatchObject({ kind: 'update', removeFromProposal: true, statusAfter: 'pending' });
    });

    it('takes it out when only the handling conditions change', () => {
        const plan = planShipmentChange(dispatch({ status: 'in_planning', routeBatchId: 4 }), {
            handlingConditions: ['FRAGILE', 'KEEP_UPRIGHT'],
        });

        expect(plan).toMatchObject({ kind: 'update', removeFromProposal: true });
    });

    it('keeps it in its batch when only the evidence policy or the packing moment changes', () => {
        const snapshot = dispatch({ status: 'in_planning', routeBatchId: 4 });

        const policy = planShipmentChange(snapshot, { evidencePolicy: 'high_value_control' });
        const packed = planShipmentChange(snapshot, { physicallyPacked: true });

        expect(policy).toMatchObject({ kind: 'update', removeFromProposal: false, statusAfter: 'in_planning' });
        expect(packed).toMatchObject({ kind: 'update', removeFromProposal: false, statusAfter: 'in_planning' });
    });
});

describe('planShipmentChange — past the promise', () => {
    it.each(['scheduled', 'assigned', 'out_for_delivery', 'in_transit', 'delivered', 'not_delivered', 'incident', 'rescheduled', 'returned'])(
        'does not modify a dispatch in %s: it asks for attention with what changed',
        (status) => {
            const plan = planShipmentChange(dispatch({ status, routeBatchId: 4 }), {
                packages: [{ ...PKG_1, grossWeightKg: 9 }],
                handlingConditions: ['FRAGILE'],
                evidencePolicy: 'high_value_control',
            });

            expect(plan.kind).toBe('attention');
            if (plan.kind !== 'attention') return;
            expect(plan.changedBlocks).toEqual(['packages', 'evidencePolicy']);
            expect(plan.diff.packages?.to).toEqual([
                { packageId: 'PKG-1', lengthCm: 40, widthCm: 30, heightCm: 25, grossWeightKg: 9, handlingConditions: ['FRAGILE'] },
            ]);
        },
    );

    it('says nothing when the change does not differ, even for a scheduled dispatch', () => {
        const plan = planShipmentChange(dispatch({ status: 'scheduled', routeBatchId: 4 }), {
            packages: [PKG_1],
            handlingConditions: ['FRAGILE'],
        });

        expect(plan).toEqual({ kind: 'noop' });
    });

    it('ignores a cancelled dispatch, with or without difference', () => {
        const cancelled = dispatch({ status: 'cancelled' });

        expect(planShipmentChange(cancelled, { packages: [{ ...PKG_1, grossWeightKg: 9 }] })).toEqual({
            kind: 'ignore',
            reason: 'dispatch_cancelled',
        });
        expect(planShipmentChange(cancelled, { packages: [PKG_1], handlingConditions: ['FRAGILE'] })).toEqual({
            kind: 'ignore',
            reason: 'dispatch_cancelled',
        });
    });
});

describe('helpers', () => {
    it('normalizes the conditions as a sorted set', () => {
        expect(normalizeConditions(['B', 'A', 'B'])).toEqual(['A', 'B']);
    });

    it('rounds a package to the scale of the table', () => {
        expect(toPackageSnapshot({ ...PKG_1, lengthCm: 40.126, grossWeightKg: 6.4567 }, ['X'])).toEqual({
            packageId: 'PKG-1',
            lengthCm: 40.13,
            widthCm: 30,
            heightCm: 25,
            grossWeightKg: 6.457,
            handlingConditions: ['X'],
        });
    });

    it('reads the conditions of a dispatch as the union of those of its packages', () => {
        expect(currentConditions([stored(PKG_1, ['A']), stored(PKG_2, ['B', 'A'])])).toEqual(['A', 'B']);
        expect(currentConditions([])).toEqual([]);
    });
});
