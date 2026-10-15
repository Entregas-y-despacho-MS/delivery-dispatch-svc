import { ConflictException } from '@nestjs/common';

export type RouteBatchApprovalConflictCode =
    | 'ROUTE_BATCH_VERSION_CONFLICT'
    | 'DISPATCH_VERSION_CONFLICT'
    | 'ROUTE_BATCH_VEHICLE_REQUIRED'
    | 'ROUTE_BATCH_HAS_NO_APPROVALS'
    | 'ROUTE_BATCH_NOT_PENDING_FINAL_REVIEW'
    | 'ROUTE_BATCH_DRIVER_REQUIRED'
    | 'ROUTE_BATCH_VEHICLE_NOT_ACTIVE'
    | 'ROUTE_BATCH_DRIVER_NOT_AVAILABLE'
    | 'ROUTE_BATCH_RESOURCE_CONFLICT'
    | 'DISPATCH_NOT_READY_FOR_FINAL_APPROVAL'
    | 'DISPATCH_PACKAGES_REQUIRED'
    | 'DISPATCH_ORDER_IN_MULTIPLE_BATCHES';

export class RouteBatchApprovalConflictException extends ConflictException {
    constructor(code: RouteBatchApprovalConflictCode, message: string) {
        super({ error: code, message });
    }
}
