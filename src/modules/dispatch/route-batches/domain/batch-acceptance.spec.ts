import { describe, expect, it } from 'vitest';
import { RouteBatchNotConfirmedException } from '../exceptions/route-batch-not-confirmed.exception.js';
import { assertDriverCanAcceptBatch, canDriverAcceptBatch } from './batch-acceptance.js';

describe('batch acceptance by the driver', () => {
    it('accepts only a confirmed batch', () => {
        expect(canDriverAcceptBatch('confirmed')).toBe(true);
        expect(() => assertDriverCanAcceptBatch('confirmed')).not.toThrow();
    });

    it.each(['provisional', 'pending_final_review', 'in_execution', 'closed', 'cancelled'])('refuses a %s batch with 409 ROUTE_BATCH_NOT_CONFIRMED', (status) => {
        expect(canDriverAcceptBatch(status)).toBe(false);
        expect(() => assertDriverCanAcceptBatch(status)).toThrow(RouteBatchNotConfirmedException);
        try {
            assertDriverCanAcceptBatch(status);
        } catch (error) {
            const exception = error as RouteBatchNotConfirmedException;
            expect(exception.getStatus()).toBe(409);
            expect(exception.getResponse()).toMatchObject({ error: 'ROUTE_BATCH_NOT_CONFIRMED', message: expect.stringContaining(status) });
        }
    });
});
