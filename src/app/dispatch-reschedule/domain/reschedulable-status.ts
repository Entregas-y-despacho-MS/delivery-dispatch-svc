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

/** States from which the coordinator can cancel the dispatch: a stop already assigned to a driver that cannot be served. */
const CANCELLABLE: readonly string[] = [DispatchStatusEnum.ASSIGNED];

export const isCancellableByCoordinator = (status: string): boolean => CANCELLABLE.includes(status);
export const isReschedulableStatus = (status: string): boolean => RESCHEDULABLE.includes(status);
export const isReturnableStatus = (status: string): boolean => RETURNABLE.includes(status);
