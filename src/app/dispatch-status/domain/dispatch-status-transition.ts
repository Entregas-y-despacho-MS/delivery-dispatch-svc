import { DispatchStatusEnum } from '../../../shared/enums/dispatch-status.enum.js';
import type { DriverDispatchStatus } from '../dto/update-dispatch-status.dto.js';
import { DispatchStatusConflictException } from '../exceptions/dispatch-status-conflict.exception.js';

const DRIVER_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
    [DispatchStatusEnum.OUT_FOR_DELIVERY]: [DispatchStatusEnum.IN_TRANSIT],
    [DispatchStatusEnum.IN_TRANSIT]: [DispatchStatusEnum.DELIVERED, DispatchStatusEnum.NOT_DELIVERED],
};

export function assertDriverDispatchTransition(current: string, target: DriverDispatchStatus): void {
    if (!(DRIVER_TRANSITIONS[current] ?? []).includes(target)) {
        throw new DispatchStatusConflictException(
            'DISPATCH_STATUS_TRANSITION_NOT_ALLOWED',
            `The dispatch cannot move from ${current} to ${target}.`,
        );
    }
}
