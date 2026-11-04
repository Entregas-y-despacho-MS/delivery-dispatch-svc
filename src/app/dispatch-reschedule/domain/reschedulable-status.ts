import { DispatchStatusEnum } from '../../../shared/enums/dispatch-status.enum.js';

/**
 * States from which the coordinator can reschedule (ES-52): a failed delivery (`incident`, `not_delivered`)
 * or, before the driver leaves, a promised one (`scheduled`, `assigned`).
 */
const RESCHEDULABLE: readonly string[] = [
    DispatchStatusEnum.INCIDENT,
    DispatchStatusEnum.NOT_DELIVERED,
    DispatchStatusEnum.SCHEDULED,
    DispatchStatusEnum.ASSIGNED,
];

/** States from which the coordinator can return the dispatch to the warehouse: only a failed delivery. */
const RETURNABLE: readonly string[] = [DispatchStatusEnum.INCIDENT, DispatchStatusEnum.NOT_DELIVERED];

/**
 * States from which the coordinator can cancel the dispatch (ES-241): any before the route starts. From `assigned` it
 * stays linked to its batch (a stop the driver cannot take); from `in_planning` and `scheduled` it leaves the batch.
 */
const CANCELLABLE: readonly string[] = [
    DispatchStatusEnum.PENDING,
    DispatchStatusEnum.ADDRESS_REVIEW,
    DispatchStatusEnum.IN_PLANNING,
    DispatchStatusEnum.SCHEDULED,
    DispatchStatusEnum.ASSIGNED,
];

/** Cancellable states in which the dispatch is still part of a batch that is not on the street: it leaves the batch. */
const LEAVES_BATCH_WHEN_CANCELLED: readonly string[] = [DispatchStatusEnum.IN_PLANNING, DispatchStatusEnum.SCHEDULED];

export const isCancellableByCoordinator = (status: string): boolean => CANCELLABLE.includes(status);
export const leavesBatchWhenCancelled = (status: string): boolean => LEAVES_BATCH_WHEN_CANCELLED.includes(status);
export const isReschedulableStatus = (status: string): boolean => RESCHEDULABLE.includes(status);
export const isReturnableStatus = (status: string): boolean => RETURNABLE.includes(status);
