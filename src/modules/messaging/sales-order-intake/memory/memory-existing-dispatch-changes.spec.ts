import { beforeEach, describe, expect, it } from 'vitest';
import type { DispatchPackageSnapshot } from '../domain/shipment-change.rules.js';
import { MemoryExistingDispatchChanges } from './memory-existing-dispatch-changes.js';

const ORDER = 'SO-2026-000123';
const OPTIONS = { manager: undefined };

const PKG_1 = { packageId: 'PKG-1', lengthCm: 40, widthCm: 30, heightCm: 25, grossWeightKg: 6.4 };
const PKG_2 = { packageId: 'PKG-2', lengthCm: 10, widthCm: 10, heightCm: 10, grossWeightKg: 1 };
const stored = (item: typeof PKG_1, handlingConditions: string[] = ['FRAGILE']): DispatchPackageSnapshot => ({
    ...item,
    handlingConditions,
});

const input = (blocks: Record<string, unknown>) => ({
    salesOrderId: ORDER,
    source: 'inventory' as const,
    receivedAt: '2026-10-13T15:00:00Z',
    blocks: blocks as never,
});

describe('MemoryExistingDispatchChanges.applyShipmentChange', () => {
    let changes: MemoryExistingDispatchChanges;

    const register = (snapshot: { status?: string; routeBatchId?: number | null } = {}) => {
        changes.add(ORDER, { dispatchId: 7, ...snapshot });
        changes.addShipment(ORDER, { packages: [stored(PKG_1)] });
    };

    beforeEach(() => {
        changes = new MemoryExistingDispatchChanges();
    });

    it('reports that there is no dispatch for an order that has none', async () => {
        await expect(changes.applyShipmentChange(input({ packages: [PKG_1] }), OPTIONS)).resolves.toEqual({
            status: 'no_dispatch',
        });
    });

    it('replaces the packages of a pending dispatch and records what changed', async () => {
        register({ status: 'pending' });

        const outcome = await changes.applyShipmentChange(
            input({ packages: [{ ...PKG_1, grossWeightKg: 9 }, PKG_2], handlingConditions: ['FRAGILE'] }),
            OPTIONS,
        );

        expect(outcome).toMatchObject({
            status: 'applied',
            dispatchId: 7,
            statusBefore: 'pending',
            statusAfter: 'pending',
            removedFromProposal: false,
            changedFields: ['packages'],
        });
        expect(changes.getShipment(ORDER)?.packages.map((item) => item.packageId)).toEqual(['PKG-1', 'PKG-2']);
        expect(changes.getShipment(ORDER)?.packages[0].grossWeightKg).toBe(9);
        expect(changes.events).toHaveLength(1);
        expect(changes.events[0].eventType).toBe('shipment_changed');
    });

    it('does nothing, and records nothing, when the message does not differ from the dispatch', async () => {
        register({ status: 'in_planning', routeBatchId: 4 });

        const outcome = await changes.applyShipmentChange(
            input({ packages: [PKG_1], handlingConditions: ['FRAGILE'] }),
            OPTIONS,
        );

        expect(outcome).toEqual({ status: 'ignored', dispatchId: 7, reason: 'no_change' });
        expect(changes.get(ORDER)).toMatchObject({ status: 'in_planning', routeBatchId: 4 });
        expect(changes.events).toEqual([]);
        expect(changes.batchVersionBumps).toEqual([]);
    });

    it('takes an in_planning dispatch out of its batch when its packages change', async () => {
        register({ status: 'in_planning', routeBatchId: 4 });

        const outcome = await changes.applyShipmentChange(
            input({ packages: [{ ...PKG_1, widthCm: 50 }], handlingConditions: ['FRAGILE'] }),
            OPTIONS,
        );

        expect(outcome).toMatchObject({ status: 'applied', statusAfter: 'pending', removedFromProposal: true });
        expect(changes.get(ORDER)).toMatchObject({ status: 'pending', routeBatchId: null });
        expect(changes.batchVersionBumps).toEqual([4]);
        expect(changes.dispatchVersionBumps).toEqual([7]);
    });

    it('keeps an in_planning dispatch in its batch when only the evidence policy changes', async () => {
        register({ status: 'in_planning', routeBatchId: 4 });

        const outcome = await changes.applyShipmentChange(input({ evidencePolicy: 'high_value_control' }), OPTIONS);

        expect(outcome).toMatchObject({ status: 'applied', removedFromProposal: false, changedFields: ['evidencePolicy'] });
        expect(changes.get(ORDER)).toMatchObject({ status: 'in_planning', routeBatchId: 4 });
        expect(changes.getShipment(ORDER)?.evidencePolicy).toBe('high_value_control');
        expect(changes.batchVersionBumps).toEqual([]);
    });

    it('fills package_ready_at when the shipment is physically packed, once', async () => {
        register({ status: 'pending' });

        const first = await changes.applyShipmentChange(input({ physicallyPacked: true }), OPTIONS);
        const second = await changes.applyShipmentChange(input({ physicallyPacked: true }), OPTIONS);

        expect(first).toMatchObject({ status: 'applied', changedFields: ['physicallyPacked'] });
        expect(changes.getShipment(ORDER)?.packageReadyAt).toBeInstanceOf(Date);
        expect(second).toEqual({ status: 'ignored', dispatchId: 7, reason: 'no_change' });
    });

    it.each(['scheduled', 'assigned', 'out_for_delivery', 'delivered'])(
        'leaves a %s dispatch untouched and asks for attention with the detail',
        async (status) => {
            register({ status, routeBatchId: 4 });

            const outcome = await changes.applyShipmentChange(
                input({ packages: [{ ...PKG_1, grossWeightKg: 9 }], handlingConditions: ['FRAGILE'] }),
                OPTIONS,
            );

            expect(outcome).toEqual({
                status: 'attention_required',
                dispatchId: 7,
                event: {
                    dispatchId: 7,
                    source: 'inventory',
                    changeType: 'order_changed',
                    receivedAt: '2026-10-13T15:00:00Z',
                },
            });
            expect(changes.get(ORDER)).toMatchObject({ status, routeBatchId: 4 });
            expect(changes.getShipment(ORDER)?.packages[0].grossWeightKg).toBe(6.4);
            expect(changes.events).toHaveLength(1);
            expect(changes.events[0]).toMatchObject({
                eventType: 'change_requires_attention',
                metadata: { changedBlocks: ['packages'] },
            });
            expect(changes.batchVersionBumps).toEqual([]);
        },
    );

    it('ignores a cancelled dispatch', async () => {
        register({ status: 'cancelled' });

        const outcome = await changes.applyShipmentChange(input({ packages: [PKG_2] }), OPTIONS);

        expect(outcome).toEqual({ status: 'ignored', dispatchId: 7, reason: 'dispatch_cancelled' });
        expect(changes.events).toEqual([]);
    });

    it('treats a dispatch without registered shipment details as having no packages', async () => {
        changes.add(ORDER, { dispatchId: 7, status: 'pending' });

        const outcome = await changes.applyShipmentChange(
            input({ packages: [PKG_1], handlingConditions: [] }),
            OPTIONS,
        );

        expect(outcome).toMatchObject({ status: 'applied', changedFields: ['packages'] });
        expect(changes.getShipment(ORDER)?.packages).toHaveLength(1);
    });
});
