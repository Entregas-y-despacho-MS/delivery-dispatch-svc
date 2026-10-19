import { DispatchStatusEnum } from '../../../../shared/enums/dispatch-status.enum.js';

/**
 * Statuses in which a dispatch is finished (RF-A08, ST-55.2): the history lists only these, and
 * `dispatches.closed_at` is set when a dispatch enters one of them. `not_delivered` counts: the
 * coordinator may reschedule it, and then it leaves the history (the database clears `closed_at`).
 */
export const TERMINAL_DISPATCH_STATUSES: readonly DispatchStatusEnum[] = [
    DispatchStatusEnum.DELIVERED,
    DispatchStatusEnum.NOT_DELIVERED,
    DispatchStatusEnum.RETURNED,
    DispatchStatusEnum.RETURNED_TO_WAREHOUSE,
    DispatchStatusEnum.CANCELLED,
];

export function isTerminalDispatchStatus(status: string): boolean {
    return (TERMINAL_DISPATCH_STATUSES as readonly string[]).includes(status);
}
