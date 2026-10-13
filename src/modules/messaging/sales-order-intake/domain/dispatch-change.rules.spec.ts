import { describe, expect, it } from 'vitest';
import {
    classifyDispatchStatus,
    isUsableLocation,
    planCancellation,
    planDeliveryChange,
    planShipmentReadiness,
    statusAfterEdit,
    type DispatchSnapshot,
} from './dispatch-change.rules.js';

function dispatch(overrides: Partial<DispatchSnapshot> = {}): DispatchSnapshot {
    return {
        dispatchId: 7,
        status: 'pending',
        routeBatchId: null,
        contactName: 'María López',
        contactPhone: '+59170000000',
        contactEmail: 'maria@example.com',
        deliveryAddress: 'Av. Arce 2345',
        deliveryReference: 'Edificio azul',
        deliveryLatitude: -16.5412,
        deliveryLongitude: -68.0731,
        deliveryZoneId: 1,
        priority: 'normal',
        shipmentReady: true,
        ...overrides,
    };
}

describe('classifyDispatchStatus', () => {
    it.each(['pending', 'address_review', 'in_planning'])('treats %s as editable', (status) => {
        expect(classifyDispatchStatus(status)).toBe('editable');
    });

    it('knows a cancelled dispatch', () => {
        expect(classifyDispatchStatus('cancelled')).toBe('cancelled');
    });

    it.each(['scheduled', 'assigned', 'out_for_delivery', 'in_transit', 'delivered', 'not_delivered', 'incident', 'returned'])(
        'treats %s as past the promise',
        (status) => {
            expect(classifyDispatchStatus(status)).toBe('beyond_promise');
        },
    );
});

describe('planDeliveryChange', () => {
    it('updates the contact of a pending dispatch and reports only what changed', () => {
        const plan = planDeliveryChange(dispatch(), {
            recipient: { name: 'María López', phone: '+59179999999', email: 'maria@example.com' },
        });

        expect(plan).toMatchObject({ kind: 'update', locationChanged: false, removeFromProposal: false });
        if (plan.kind !== 'update') return;
        expect(plan.columns).toEqual({ contactPhone: '+59179999999' });
        expect(plan.diff).toEqual({ contactPhone: { from: '+59170000000', to: '+59179999999' } });
        expect(plan.changedBlocks).toEqual(['recipient']);
    });

    it('clears the email and the reference when the new block does not carry them', () => {
        const plan = planDeliveryChange(dispatch(), {
            recipient: { name: 'María López', phone: '+59170000000' },
            deliveryAddress: { line: 'Av. Arce 2345', location: { latitude: -16.5412, longitude: -68.0731 } },
        });

        expect(plan.kind).toBe('update');
        if (plan.kind !== 'update') return;
        expect(plan.columns).toEqual({ contactEmail: null, deliveryReference: null });
    });

    it('marks the location as changed whenever the address block is sent', () => {
        const plan = planDeliveryChange(dispatch(), {
            deliveryAddress: { line: 'Calle 21 de Calacoto', location: { latitude: -16.54, longitude: -68.08 } },
        });

        expect(plan).toMatchObject({ kind: 'update', locationChanged: true });
        if (plan.kind !== 'update') return;
        expect(plan.columns).toMatchObject({
            deliveryAddress: 'Calle 21 de Calacoto',
            deliveryLatitude: -16.54,
            deliveryLongitude: -68.08,
        });
    });

    it('stores null coordinates when the new address has no usable location', () => {
        const plan = planDeliveryChange(dispatch(), {
            deliveryAddress: { line: 'Av. Arce 2345', reference: 'Edificio azul' },
        });

        expect(plan.kind).toBe('update');
        if (plan.kind !== 'update') return;
        expect(plan.columns).toEqual({ deliveryLatitude: null, deliveryLongitude: null });
    });

    it('takes a dispatch of the proposed batch out of it when something changed', () => {
        const plan = planDeliveryChange(dispatch({ status: 'in_planning', routeBatchId: 4 }), {
            recipient: { name: 'María López', phone: '+59179999999', email: 'maria@example.com' },
        });

        expect(plan).toMatchObject({ kind: 'update', removeFromProposal: true });
    });

    it('keeps its place in the proposal when the change does not alter the dispatch', () => {
        const plan = planDeliveryChange(dispatch({ status: 'in_planning', routeBatchId: 4 }), {
            recipient: { name: 'María López', phone: '+59170000000', email: 'maria@example.com' },
            preferences: { contactless: true },
        });

        expect(plan).toMatchObject({ kind: 'update', removeFromProposal: false });
        if (plan.kind !== 'update') return;
        expect(plan.columns).toEqual({});
        expect(plan.changedBlocks).toEqual(['recipient', 'preferences']);
    });

    it('edits an address_review dispatch', () => {
        const plan = planDeliveryChange(dispatch({ status: 'address_review' }), {
            deliveryAddress: { line: 'Otra', location: { latitude: -16.5, longitude: -68.1 } },
        });

        expect(plan.kind).toBe('update');
    });

    it.each(['scheduled', 'assigned', 'out_for_delivery', 'delivered'])(
        'does not modify a dispatch in %s: it asks for attention and says what changed',
        (status) => {
            const plan = planDeliveryChange(dispatch({ status }), {
                deliveryAddress: { line: 'Otra' },
                priority: 'urgent',
            });

            expect(plan).toEqual({ kind: 'attention', changedBlocks: ['deliveryAddress', 'priority'] });
        },
    );

    it('ignores a change for a cancelled dispatch', () => {
        expect(planDeliveryChange(dispatch({ status: 'cancelled' }), { priority: 'urgent' })).toEqual({
            kind: 'ignore',
            reason: 'dispatch_cancelled',
        });
    });
});

describe('planCancellation', () => {
    it('cancels a pending dispatch', () => {
        expect(planCancellation(dispatch())).toEqual({ kind: 'cancel', removeFromProposal: false });
    });

    it('cancels an in_planning dispatch and takes it out of its batch', () => {
        expect(planCancellation(dispatch({ status: 'in_planning', routeBatchId: 4 }))).toEqual({
            kind: 'cancel',
            removeFromProposal: true,
        });
    });

    it('cancels an address_review dispatch', () => {
        expect(planCancellation(dispatch({ status: 'address_review' }))).toEqual({
            kind: 'cancel',
            removeFromProposal: false,
        });
    });

    it.each(['scheduled', 'assigned', 'out_for_delivery'])('asks for attention instead of cancelling %s', (status) => {
        expect(planCancellation(dispatch({ status }))).toEqual({ kind: 'attention' });
    });

    it('is a no-op for a dispatch that is already cancelled', () => {
        expect(planCancellation(dispatch({ status: 'cancelled' }))).toEqual({
            kind: 'ignore',
            reason: 'dispatch_cancelled',
        });
    });
});

describe('planShipmentReadiness', () => {
    it('marks a pending dispatch as not ready', () => {
        expect(planShipmentReadiness(dispatch(), false)).toEqual({
            kind: 'set',
            ready: false,
            removeFromProposal: false,
        });
    });

    it('takes an in_planning dispatch out of the proposal when it stops being ready', () => {
        expect(planShipmentReadiness(dispatch({ status: 'in_planning', routeBatchId: 4 }), false)).toEqual({
            kind: 'set',
            ready: false,
            removeFromProposal: true,
        });
    });

    it('marks it as ready again without touching a batch', () => {
        expect(planShipmentReadiness(dispatch({ shipmentReady: false }), true)).toEqual({
            kind: 'set',
            ready: true,
            removeFromProposal: false,
        });
    });

    it('does nothing when the readiness is already the one reported', () => {
        expect(planShipmentReadiness(dispatch({ shipmentReady: true }), true)).toEqual({ kind: 'noop' });
        expect(planShipmentReadiness(dispatch({ shipmentReady: false }), false)).toEqual({ kind: 'noop' });
    });

    it('asks for attention for any readiness change after the promise, including delivered and returned', () => {
        expect(planShipmentReadiness(dispatch({ status: 'scheduled' }), false)).toEqual({ kind: 'attention' });
        expect(planShipmentReadiness(dispatch({ status: 'scheduled', shipmentReady: false }), true)).toEqual({
            kind: 'attention',
        });
        expect(planShipmentReadiness(dispatch({ status: 'delivered', shipmentReady: false }), true)).toEqual({
            kind: 'attention',
        });
        expect(planShipmentReadiness(dispatch({ status: 'returned', shipmentReady: true }), false)).toEqual({
            kind: 'attention',
        });
    });

    it('ignores a cancelled dispatch', () => {
        expect(planShipmentReadiness(dispatch({ status: 'cancelled' }), false)).toEqual({
            kind: 'ignore',
            reason: 'dispatch_cancelled',
        });
    });
});

describe('statusAfterEdit', () => {
    it('sends the dispatch to address_review when the new address has no zone', () => {
        expect(
            statusAfterEdit({ current: 'pending', removedFromProposal: false, locationChanged: true, hasZone: false }),
        ).toBe('address_review');
    });

    it('brings an address_review dispatch back to pending when its address now has a zone', () => {
        expect(
            statusAfterEdit({
                current: 'address_review',
                removedFromProposal: false,
                locationChanged: true,
                hasZone: true,
            }),
        ).toBe('pending');
    });

    it('returns an in_planning dispatch to pending when it leaves the proposal', () => {
        expect(
            statusAfterEdit({ current: 'in_planning', removedFromProposal: true, locationChanged: false, hasZone: true }),
        ).toBe('pending');
    });

    it('keeps address_review when only the contact changed', () => {
        expect(
            statusAfterEdit({
                current: 'address_review',
                removedFromProposal: false,
                locationChanged: false,
                hasZone: true,
            }),
        ).toBe('address_review');
    });

    it('keeps pending when nothing relevant happened', () => {
        expect(
            statusAfterEdit({ current: 'pending', removedFromProposal: false, locationChanged: false, hasZone: true }),
        ).toBe('pending');
    });

    it('prefers address_review over pending for an in_planning dispatch that lost its zone', () => {
        expect(
            statusAfterEdit({ current: 'in_planning', removedFromProposal: true, locationChanged: true, hasZone: false }),
        ).toBe('address_review');
    });
});

describe('isUsableLocation', () => {
    it('accepts coordinates inside the valid ranges', () => {
        expect(isUsableLocation({ latitude: -16.5, longitude: -68.1 })).toBe(true);
    });

    it.each([
        ['missing', undefined],
        ['latitude out of range', { latitude: 91, longitude: 0 }],
        ['longitude out of range', { latitude: 0, longitude: -181 }],
        ['not finite', { latitude: Number.NaN, longitude: 0 }],
    ])('rejects a location that is %s', (_name, location) => {
        expect(isUsableLocation(location as never)).toBe(false);
    });
});
