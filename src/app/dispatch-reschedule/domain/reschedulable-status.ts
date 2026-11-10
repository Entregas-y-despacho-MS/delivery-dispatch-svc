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

/**
 * Customer-pickup cancellation follows the ES-81 GWT contract: `pickup_scheduled` and `in_planning` only.
 */
const PICKUP_CANCELLABLE: readonly string[] = [
    DispatchStatusEnum.PICKUP_SCHEDULED,
    DispatchStatusEnum.IN_PLANNING,
];

/** Cancellable states by dispatch type: the cancellation endpoint of each type only accepts its own list. */
const CANCELLABLE_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
    delivery:                CANCELLABLE,
    warehouse_return_pickup: PICKUP_CANCELLABLE,
};

/**
 * Cancellable states in which the dispatch is still part of a batch that is not on the street: it leaves the batch.
 * `pickup_scheduled` is here too (ST-81.3): a customer pickup the generator already placed in a provisional batch
 * never moves past this status until the 2nd approval, so cancelling it from here must free its place too.
 */
const LEAVES_BATCH_WHEN_CANCELLED: readonly string[] = [
    DispatchStatusEnum.IN_PLANNING,
    DispatchStatusEnum.SCHEDULED,
    DispatchStatusEnum.PICKUP_SCHEDULED,
];

/** `type` defaults to `delivery` (the original cancellation of ES-241). */
export const isCancellableByCoordinator = (status: string, type: string = 'delivery'): boolean =>
    (CANCELLABLE_BY_TYPE[type] ?? []).includes(status);
/** The cancellable states of a type, for the message of the 409. */
export const cancellableStatusesOf = (type: string): readonly string[] => CANCELLABLE_BY_TYPE[type] ?? [];
export const leavesBatchWhenCancelled = (status: string): boolean => LEAVES_BATCH_WHEN_CANCELLED.includes(status);
export const isReschedulableStatus = (status: string): boolean => RESCHEDULABLE.includes(status);
export const isReturnableStatus = (status: string): boolean => RETURNABLE.includes(status);
