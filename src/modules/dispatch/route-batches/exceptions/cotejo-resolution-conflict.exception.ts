import { ConflictException } from '@nestjs/common';

export type CotejoResolutionConflictCode =
  | 'ROUTE_BATCH_NOT_IN_EXECUTION'
  | 'COTEJO_DISPATCH_NOT_ASSIGNED'
  | 'COTEJO_EXCLUSION_NOT_PENDING';

/** The coordinator tried to resolve a stop that is not (or no longer) left out of the route by a failed package check. */
export class CotejoResolutionConflictException extends ConflictException {
  constructor(code: CotejoResolutionConflictCode, message: string) {
    super({ error: code, message });
  }
}
