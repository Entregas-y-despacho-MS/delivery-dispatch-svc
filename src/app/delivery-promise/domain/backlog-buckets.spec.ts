import { describe, expect, it } from 'vitest';
import { DispatchStatusEnum } from '../../../shared/enums/dispatch-status.enum.js';
import { TERMINAL_DISPATCH_STATUSES } from '../../../modules/dispatch/dispatches/utils/terminal-statuses.js';
import { ACTIVE_DISPATCH_STATUSES, AgeRange, BacklogBucket, ageRangeOf, bucketOf, nextActionOf } from './backlog-buckets.js';

describe('bucketOf', () => {
    it('maps every status of the enum to exactly one bucket (none throws)', () => {
        for (const status of Object.values(DispatchStatusEnum)) {
            expect(() => bucketOf(status, false), status).not.toThrow();
            expect(() => bucketOf(status, true), status).not.toThrow();
        }
    });

    it('counts the terminal statuses in their own bucket whatever the promise says', () => {
        for (const overdue of [true, false]) {
            expect(bucketOf(DispatchStatusEnum.DELIVERED, overdue)).toBe(BacklogBucket.DELIVERED);
            expect(bucketOf(DispatchStatusEnum.NOT_DELIVERED, overdue)).toBe(BacklogBucket.NOT_DELIVERED);
            expect(bucketOf(DispatchStatusEnum.CANCELLED, overdue)).toBe(BacklogBucket.CANCELLED);
            expect(bucketOf(DispatchStatusEnum.RESCHEDULED, overdue)).toBe(BacklogBucket.RESCHEDULED);
        }
    });

    it('groups returned and returned_to_warehouse as returned', () => {
        expect(bucketOf(DispatchStatusEnum.RETURNED, false)).toBe(BacklogBucket.RETURNED);
        expect(bucketOf(DispatchStatusEnum.RETURNED_TO_WAREHOUSE, true)).toBe(BacklogBucket.RETURNED);
    });

    it('splits an active dispatch into open overdue or pending, never both', () => {
        for (const status of ACTIVE_DISPATCH_STATUSES) {
            expect(bucketOf(status, true), status).toBe(BacklogBucket.OPEN_OVERDUE);
            expect(bucketOf(status, false), status).toBe(BacklogBucket.PENDING);
        }
    });

    it('keeps the terminal statuses and rescheduled out of the active ones', () => {
        for (const status of TERMINAL_DISPATCH_STATUSES) expect(ACTIVE_DISPATCH_STATUSES).not.toContain(status);
        expect(ACTIVE_DISPATCH_STATUSES).not.toContain(DispatchStatusEnum.RESCHEDULED);
    });

    it('rejects a status that does not exist', () => {
        expect(() => bucketOf('teleported', false)).toThrow(RangeError);
    });
});

describe('ageRangeOf', () => {
    it('uses exclusive upper bounds', () => {
        expect(ageRangeOf(0)).toBe(AgeRange.UNDER_1_DAY);
        expect(ageRangeOf(1_439)).toBe(AgeRange.UNDER_1_DAY);
        expect(ageRangeOf(1_440)).toBe(AgeRange.ONE_TO_3_DAYS);
        expect(ageRangeOf(4_319)).toBe(AgeRange.ONE_TO_3_DAYS);
        expect(ageRangeOf(4_320)).toBe(AgeRange.OVER_3_DAYS);
    });

    it('puts a negative age (wrong clock) in the youngest range', () => {
        expect(ageRangeOf(-30)).toBe(AgeRange.UNDER_1_DAY);
    });
});

describe('nextActionOf', () => {
    it('has a next action for every active status', () => {
        for (const status of ACTIVE_DISPATCH_STATUSES) expect(() => nextActionOf(status), status).not.toThrow();
    });

    it('has none for a finished one', () => {
        expect(() => nextActionOf(DispatchStatusEnum.DELIVERED)).toThrow(RangeError);
    });
});
