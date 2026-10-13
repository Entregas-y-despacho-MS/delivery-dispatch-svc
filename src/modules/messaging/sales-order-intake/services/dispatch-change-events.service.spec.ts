import { describe, expect, it, vi } from 'vitest';
import type { DispatchChangeOutcome } from '../ports/existing-dispatch-changes.port.js';
import { DISPATCH_CHANGE_REQUIRES_ATTENTION, DispatchChangeEvents } from './dispatch-change-events.service.js';

const attention = (dispatchId: number): DispatchChangeOutcome => ({
    status: 'attention_required',
    dispatchId,
    event: { dispatchId, source: 'marketplace', changeType: 'order_changed', receivedAt: '2026-10-12T15:00:00Z' },
});

describe('DispatchChangeEvents', () => {
    it('emits one event per dispatch that needs attention, with the catalog payload', () => {
        const emitter = { emit: vi.fn() };
        const events = new DispatchChangeEvents(emitter as never);

        events.emitAfterCommit([attention(7), attention(9)]);

        expect(emitter.emit).toHaveBeenCalledTimes(2);
        expect(emitter.emit).toHaveBeenNthCalledWith(1, DISPATCH_CHANGE_REQUIRES_ATTENTION, {
            dispatchId: 7,
            source: 'marketplace',
            changeType: 'order_changed',
            receivedAt: '2026-10-12T15:00:00Z',
        });
    });

    it('emits nothing for outcomes that did not ask for attention', () => {
        const emitter = { emit: vi.fn() };
        const events = new DispatchChangeEvents(emitter as never);

        events.emitAfterCommit([
            { status: 'no_dispatch' },
            { status: 'ignored', dispatchId: 7, reason: 'no_change' },
            {
                status: 'applied',
                dispatchId: 7,
                statusBefore: 'pending',
                statusAfter: 'pending',
                removedFromProposal: false,
                changedFields: ['contactPhone'],
            },
        ]);

        expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('does not throw when a listener fails and still emits the rest', () => {
        const emitter = {
            emit: vi
                .fn()
                .mockImplementationOnce(() => {
                    throw new Error('listener failed');
                })
                .mockImplementation(() => true),
        };
        const events = new DispatchChangeEvents(emitter as never);

        expect(() => events.emitAfterCommit([attention(7), attention(9)])).not.toThrow();
        expect(emitter.emit).toHaveBeenCalledTimes(2);
    });

    it('tells the coordinators once when one message asked for attention twice', () => {
        const emitter = { emit: vi.fn() };
        const events = new DispatchChangeEvents(emitter as never);

        events.emitAfterCommit([attention(7), attention(7), attention(9)]);

        expect(emitter.emit).toHaveBeenCalledTimes(2);
        expect(emitter.emit.mock.calls.map(([, payload]) => payload.dispatchId)).toEqual([7, 9]);
    });

    it('still emits events that differ for the same dispatch', () => {
        const emitter = { emit: vi.fn() };
        const events = new DispatchChangeEvents(emitter as never);
        const cancelled: DispatchChangeOutcome = {
            status: 'attention_required',
            dispatchId: 7,
            event: { dispatchId: 7, source: 'marketplace', changeType: 'order_cancelled', receivedAt: '2026-10-12T15:00:00Z' },
        };

        events.emitAfterCommit([attention(7), cancelled]);

        expect(emitter.emit).toHaveBeenCalledTimes(2);
    });

    it('uses the name of the catalog', () => {
        expect(DISPATCH_CHANGE_REQUIRES_ATTENTION).toBe('dispatch.change_requires_attention');
    });
});
