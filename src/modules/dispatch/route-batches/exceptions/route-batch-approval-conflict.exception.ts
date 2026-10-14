import { ConflictException } from '@nestjs/common';

export type RouteBatchApprovalConflictCode = 'ROUTE_BATCH_VERSION_CONFLICT' | 'DISPATCH_VERSION_CONFLICT' | 'ROUTE_BATCH_VEHICLE_REQUIRED' | 'ROUTE_BATCH_HAS_NO_APPROVALS';

export class RouteBatchApprovalConflictException extends ConflictException {
    constructor(code: RouteBatchApprovalConflictCode, message: string) {
        super({ error: code, message });
    }
}
