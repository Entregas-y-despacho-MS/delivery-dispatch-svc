import { ConflictException } from '@nestjs/common';

export type RouteBatchReassignConflictCode =
    | 'ROUTE_BATCH_SAME_BATCH'
    | 'ROUTE_BATCH_NOT_IN_EXECUTION'
    | 'ROUTE_BATCH_DIFFERENT_SHIFT_DATE'
    | 'ROUTE_BATCH_VERSION_CONFLICT'
    | 'ROUTE_BATCH_VEHICLE_REQUIRED'
    | 'DISPATCH_NOT_IN_BATCH'
    | 'DISPATCH_NOT_OUT_FOR_DELIVERY';

export class RouteBatchReassignConflictException extends ConflictException {
    constructor(code: RouteBatchReassignConflictCode, message: string) {
        super({ error: code, message });
    }
}
