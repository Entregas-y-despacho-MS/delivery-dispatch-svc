import { describe, expect, it } from 'vitest';
import { applyMarketplaceMessage, emptyMarketplaceOrderState } from './apply-marketplace-message.js';
import type {
    CancelledOrderData,
    ConfirmedOrderData,
    MarketplaceOrderState,
    UpdatedOrderData,
} from './marketplace-order.types.js';

const ORDER = 'SO-2026-000123';

function confirmed(overrides: Partial<ConfirmedOrderData> = {}): ConfirmedOrderData {
    return {
        salesOrderId: ORDER,
        recordVersion: 1,
        updatedAt: '2026-10-11T14:00:00Z',
        confirmedAt: '2026-10-11T13:58:00Z',
        recipient: { name: 'María López', phone: '+59170000000', email: 'maria@example.com' },
        deliveryAddress: {
            line: 'Av. Arce 2345, Sopocachi',
            reference: 'Edificio azul, departamento 4B',
            location: { latitude: -16.5412, longitude: -68.0731 },
        },
        ...overrides,
    };
}

function updated(overrides: Partial<UpdatedOrderData> = {}): UpdatedOrderData {
    return {
        salesOrderId: ORDER,
        recordVersion: 2,
        updatedAt: '2026-10-11T15:00:00Z',
        ...overrides,
    };
}

function cancelled(overrides: Partial<CancelledOrderData> = {}): CancelledOrderData {
    return {
        salesOrderId: ORDER,
        recordVersion: 3,
        updatedAt: '2026-10-11T16:00:00Z',
        cancelledAt: '2026-10-11T15:59:00Z',
        ...overrides,
    };
}

/** State after a valid `confirmed` v1, built through the function under test. */
function stateAfterConfirmed(): MarketplaceOrderState {
    return applyMarketplaceMessage(null, { kind: 'confirmed', data: confirmed() }).state;
}

describe('applyMarketplaceMessage — confirmed', () => {
    it('creates the state of an order that was never seen', () => {
        const result = applyMarketplaceMessage(null, { kind: 'confirmed', data: confirmed() });

        expect(result.outcome).toBe('applied');
        expect(result.state).toEqual({
            salesOrderId: ORDER,
            lastRecordVersion: 1,
            baseReceived: true,
            cancelledAt: null,
            cancelledVersion: null,
            blocks: {
                confirmedAt: '2026-10-11T13:58:00Z',
                recipient: { name: 'María López', phone: '+59170000000', email: 'maria@example.com' },
                deliveryAddress: {
                    line: 'Av. Arce 2345, Sopocachi',
                    reference: 'Edificio azul, departamento 4B',
                    location: { latitude: -16.5412, longitude: -68.0731 },
                },
            },
        });
    });

    it('accepts an order without email and without coordinates', () => {
        const result = applyMarketplaceMessage(null, {
            kind: 'confirmed',
            data: confirmed({
                recipient: { name: 'Juan Pérez', phone: '+59171111111' },
                deliveryAddress: { line: 'Calle 21 de Calacoto' },
            }),
        });

        expect(result.outcome).toBe('applied');
        expect(result.state.blocks.recipient).toEqual({ name: 'Juan Pérez', phone: '+59171111111' });
        expect(result.state.blocks.deliveryAddress?.location).toBeUndefined();
    });

    it('keeps the optional blocks it brings', () => {
        const result = applyMarketplaceMessage(null, {
            kind: 'confirmed',
            data: confirmed({
                preferences: { contactless: true, notes: 'Dejar con portería' },
                deliveryDeadline: '2026-10-20T20:00:00Z',
                priority: 'urgent',
            }),
        });

        expect(result.state.blocks.preferences).toEqual({ contactless: true, notes: 'Dejar con portería' });
        expect(result.state.blocks.deliveryDeadline).toBe('2026-10-20T20:00:00Z');
        expect(result.state.blocks.priority).toBe('urgent');
    });

    it('ignores the same version delivered again and returns the same state object', () => {
        const state = stateAfterConfirmed();

        const result = applyMarketplaceMessage(state, { kind: 'confirmed', data: confirmed() });

        expect(result.outcome).toBe('ignored_stale');
        expect(result.state).toBe(state);
    });

    it('applies a newer confirmed by replacing the blocks it brings and keeping the others', () => {
        const state = applyMarketplaceMessage(null, {
            kind: 'confirmed',
            data: confirmed({ priority: 'urgent' }),
        }).state;

        const result = applyMarketplaceMessage(state, {
            kind: 'confirmed',
            data: confirmed({
                recordVersion: 4,
                recipient: { name: 'María L. Rojas', phone: '+59172222222' },
            }),
        });

        expect(result.outcome).toBe('applied');
        expect(result.state.lastRecordVersion).toBe(4);
        expect(result.state.blocks.recipient).toEqual({ name: 'María L. Rojas', phone: '+59172222222' });
        expect(result.state.blocks.priority).toBe('urgent');
    });
});

describe('applyMarketplaceMessage — updated', () => {
    it('replaces a block as a whole, not field by field', () => {
        const state = stateAfterConfirmed();

        const result = applyMarketplaceMessage(state, {
            kind: 'updated',
            data: updated({ recipient: { name: 'María López', phone: '+59179999999' } }),
        });

        expect(result.outcome).toBe('applied');
        // The email of the previous block is gone: the new block replaced it entirely.
        expect(result.state.blocks.recipient).toEqual({ name: 'María López', phone: '+59179999999' });
    });

    it('does not change the blocks that are absent', () => {
        const state = stateAfterConfirmed();

        const result = applyMarketplaceMessage(state, {
            kind: 'updated',
            data: updated({ preferences: { contactless: true } }),
        });

        expect(result.state.blocks.recipient).toEqual(state.blocks.recipient);
        expect(result.state.blocks.deliveryAddress).toEqual(state.blocks.deliveryAddress);
        expect(result.state.blocks.confirmedAt).toBe('2026-10-11T13:58:00Z');
        expect(result.state.blocks.preferences).toEqual({ contactless: true });
        expect(result.state.lastRecordVersion).toBe(2);
    });

    it('ignores an updated with a lower or equal version', () => {
        const state = applyMarketplaceMessage(stateAfterConfirmed(), {
            kind: 'updated',
            data: updated({ recordVersion: 5, preferences: { contactless: true } }),
        }).state;

        const older = applyMarketplaceMessage(state, {
            kind: 'updated',
            data: updated({ recordVersion: 4, preferences: { contactless: false } }),
        });
        const equal = applyMarketplaceMessage(state, {
            kind: 'updated',
            data: updated({ recordVersion: 5, preferences: { contactless: false } }),
        });

        expect(older.outcome).toBe('ignored_stale');
        expect(equal.outcome).toBe('ignored_stale');
        expect(older.state).toBe(state);
        expect(equal.state.blocks.preferences).toEqual({ contactless: true });
    });

    it('is kept while waiting for the base, without marking the base as received', () => {
        const result = applyMarketplaceMessage(null, {
            kind: 'updated',
            data: updated({ recipient: { name: 'María López', phone: '+59170000000' } }),
        });

        expect(result.outcome).toBe('applied');
        expect(result.state.baseReceived).toBe(false);
        expect(result.state.lastRecordVersion).toBe(2);
        expect(result.state.blocks.confirmedAt).toBeUndefined();
    });
});

describe('applyMarketplaceMessage — confirmed that arrives after an updated', () => {
    function stateWithUpdatedFirst(): MarketplaceOrderState {
        return applyMarketplaceMessage(null, {
            kind: 'updated',
            data: updated({
                recipient: { name: 'María López', phone: '+59179999999' },
                deliveryAddress: { line: 'Av. 6 de Agosto 1000' },
            }),
        }).state;
    }

    it('completes only the missing blocks and never lowers the version', () => {
        const result = applyMarketplaceMessage(stateWithUpdatedFirst(), {
            kind: 'confirmed',
            data: confirmed({ priority: 'urgent', preferences: { contactless: true } }),
        });

        expect(result.outcome).toBe('base_completed_late');
        expect(result.state.baseReceived).toBe(true);
        expect(result.state.lastRecordVersion).toBe(2);
        // The newer blocks of the updated win over the ones of the late confirmed.
        expect(result.state.blocks.recipient).toEqual({ name: 'María López', phone: '+59179999999' });
        expect(result.state.blocks.deliveryAddress).toEqual({ line: 'Av. 6 de Agosto 1000' });
        // What the updated did not bring is filled by the confirmed.
        expect(result.state.blocks.confirmedAt).toBe('2026-10-11T13:58:00Z');
        expect(result.state.blocks.priority).toBe('urgent');
        expect(result.state.blocks.preferences).toEqual({ contactless: true });
    });

    it('is ignored once the base was received', () => {
        const completed = applyMarketplaceMessage(stateWithUpdatedFirst(), {
            kind: 'confirmed',
            data: confirmed(),
        }).state;

        const again = applyMarketplaceMessage(completed, { kind: 'confirmed', data: confirmed() });

        expect(again.outcome).toBe('ignored_stale');
        expect(again.state).toBe(completed);
    });
});

describe('applyMarketplaceMessage — cancelled', () => {
    it('marks the order as cancelled with its version and keeps the blocks', () => {
        const state = stateAfterConfirmed();

        const result = applyMarketplaceMessage(state, { kind: 'cancelled', data: cancelled() });

        expect(result.outcome).toBe('applied');
        expect(result.state.cancelledAt).toBe('2026-10-11T15:59:00Z');
        expect(result.state.cancelledVersion).toBe(3);
        expect(result.state.lastRecordVersion).toBe(3);
        expect(result.state.blocks).toEqual(state.blocks);
    });

    it('is terminal: a newer updated or confirmed does not reactivate the order', () => {
        const state = applyMarketplaceMessage(stateAfterConfirmed(), {
            kind: 'cancelled',
            data: cancelled(),
        }).state;

        const afterUpdated = applyMarketplaceMessage(state, {
            kind: 'updated',
            data: updated({ recordVersion: 9, preferences: { contactless: true } }),
        });
        const afterConfirmed = applyMarketplaceMessage(state, {
            kind: 'confirmed',
            data: confirmed({ recordVersion: 10 }),
        });

        expect(afterUpdated.outcome).toBe('ignored_cancelled');
        expect(afterConfirmed.outcome).toBe('ignored_cancelled');
        expect(afterUpdated.state).toBe(state);
        expect(afterConfirmed.state.cancelledAt).toBe('2026-10-11T15:59:00Z');
    });

    it('ignores a second cancellation', () => {
        const state = applyMarketplaceMessage(stateAfterConfirmed(), {
            kind: 'cancelled',
            data: cancelled(),
        }).state;

        const again = applyMarketplaceMessage(state, {
            kind: 'cancelled',
            data: cancelled({ recordVersion: 4, cancelledAt: '2026-10-11T17:00:00Z' }),
        });

        expect(again.outcome).toBe('ignored_cancelled');
        expect(again.state.cancelledVersion).toBe(3);
    });

    it('is recorded even when the order never had a base, so a late confirmed cannot create it', () => {
        const cancelledFirst = applyMarketplaceMessage(null, {
            kind: 'cancelled',
            data: cancelled({ recordVersion: 2 }),
        });

        expect(cancelledFirst.outcome).toBe('applied');
        expect(cancelledFirst.state.baseReceived).toBe(false);
        expect(cancelledFirst.state.cancelledVersion).toBe(2);

        const lateConfirmed = applyMarketplaceMessage(cancelledFirst.state, {
            kind: 'confirmed',
            data: confirmed({ recordVersion: 1 }),
        });

        expect(lateConfirmed.outcome).toBe('ignored_cancelled');
        expect(lateConfirmed.state.baseReceived).toBe(false);
        expect(lateConfirmed.state.blocks.recipient).toBeUndefined();
    });

    it('ignores a stale cancellation and leaves the order active', () => {
        const state = applyMarketplaceMessage(stateAfterConfirmed(), {
            kind: 'updated',
            data: updated({ recordVersion: 5, preferences: { contactless: true } }),
        }).state;

        const result = applyMarketplaceMessage(state, {
            kind: 'cancelled',
            data: cancelled({ recordVersion: 4 }),
        });

        expect(result.outcome).toBe('ignored_stale');
        expect(result.state.cancelledAt).toBeNull();
        expect(result.state).toBe(state);
    });
});

describe('applyMarketplaceMessage — purity', () => {
    it('does not mutate the state or the message it receives', () => {
        const state = stateAfterConfirmed();
        const stateBefore = structuredClone(state);
        const data = updated({ deliveryAddress: { line: 'Otra calle', location: { latitude: -16.5, longitude: -68.1 } } });
        const dataBefore = structuredClone(data);

        applyMarketplaceMessage(state, { kind: 'updated', data });

        expect(state).toEqual(stateBefore);
        expect(data).toEqual(dataBefore);
    });

    it('does not share block objects with the message', () => {
        const data = confirmed();

        const { state } = applyMarketplaceMessage(null, { kind: 'confirmed', data });
        data.deliveryAddress.line = 'Changed after applying';
        data.recipient.name = 'Changed after applying';

        expect(state.blocks.deliveryAddress?.line).toBe('Av. Arce 2345, Sopocachi');
        expect(state.blocks.recipient?.name).toBe('María López');
    });

    it('starts from the empty state of the order when none is given', () => {
        expect(emptyMarketplaceOrderState(ORDER)).toEqual({
            salesOrderId: ORDER,
            lastRecordVersion: 0,
            baseReceived: false,
            cancelledAt: null,
            cancelledVersion: null,
            blocks: {},
        });
    });
});
