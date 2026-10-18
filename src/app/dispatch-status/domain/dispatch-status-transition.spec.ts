import { describe, expect, it } from 'vitest';
import { DispatchStatusEnum } from '../../../shared/enums/dispatch-status.enum.js';
import { DispatchStatusConflictException } from '../exceptions/dispatch-status-conflict.exception.js';
import { assertDriverDispatchTransition } from './dispatch-status-transition.js';

describe('assertDriverDispatchTransition', () => {
    it.each([
        [DispatchStatusEnum.OUT_FOR_DELIVERY, DispatchStatusEnum.IN_TRANSIT],
        [DispatchStatusEnum.IN_TRANSIT, DispatchStatusEnum.DELIVERED],
        [DispatchStatusEnum.IN_TRANSIT, DispatchStatusEnum.NOT_DELIVERED],
    ])('allows %s -> %s', (current, target) => {
        expect(() => assertDriverDispatchTransition(current, target)).not.toThrow();
    });

    it.each([
        [DispatchStatusEnum.ASSIGNED, DispatchStatusEnum.IN_TRANSIT],
        [DispatchStatusEnum.OUT_FOR_DELIVERY, DispatchStatusEnum.DELIVERED],
        [DispatchStatusEnum.IN_TRANSIT, DispatchStatusEnum.RETURNED],
        [DispatchStatusEnum.IN_TRANSIT, DispatchStatusEnum.IN_TRANSIT],
    ])('rejects %s -> %s', (current, target) => {
        try {
            assertDriverDispatchTransition(current, target as never);
            throw new Error('Expected transition to be rejected');
        } catch (error) {
            expect(error).toBeInstanceOf(DispatchStatusConflictException);
            expect((error as DispatchStatusConflictException).getStatus()).toBe(409);
        }
    });
});
