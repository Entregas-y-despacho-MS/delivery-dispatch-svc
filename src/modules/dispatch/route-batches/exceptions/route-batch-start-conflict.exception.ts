import { ConflictException } from '@nestjs/common';

export type RouteBatchStartConflictCode =
  | 'ROUTE_BATCH_NOT_CONFIRMED'
  | 'ROUTE_BATCH_DRIVER_REQUIRED'
  | 'ROUTE_BATCH_HAS_NO_DISPATCHES'
  | 'DISPATCH_NOT_ASSIGNED'
  | 'DISPATCH_PACKAGES_REQUIRED'
  | 'DISPATCH_TRACKING_CODE_REQUIRED'
  | 'ROUTE_START_EVENT_ID_ALREADY_USED';

export class RouteBatchStartConflictException extends ConflictException {
  constructor(code: RouteBatchStartConflictCode, message: string) {
    super({ error: code, message });
  }
}
