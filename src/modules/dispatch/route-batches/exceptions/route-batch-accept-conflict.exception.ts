import { BadRequestException, ConflictException } from '@nestjs/common';

export type RouteBatchAcceptConflictCode =
  | 'ROUTE_BATCH_ALREADY_ACCEPTED'
  | 'ROUTE_ACCEPT_EVENT_ID_ALREADY_USED';

export class RouteBatchAcceptConflictException extends ConflictException {
  constructor(code: RouteBatchAcceptConflictCode, message: string) {
    super({ error: code, message });
  }
}

export type CotejoFailureInvalidCode =
  | 'COTEJO_FAILURE_DUPLICATED_DISPATCH'
  | 'COTEJO_FAILURE_DISPATCH_NOT_IN_BATCH'
  | 'COTEJO_FAILURE_DISPATCH_NOT_ASSIGNED'
  | 'COTEJO_FAILURE_PACKAGE_NOT_IN_DISPATCH'
  | 'COTEJO_PHOTO_NOT_FOUND';

/** A failure of the cotejo that does not match the batch: wrong dispatch or package, or a photo never uploaded for it. */
export class CotejoFailureInvalidException extends BadRequestException {
  constructor(code: CotejoFailureInvalidCode, message: string) {
    super({ error: code, message });
  }
}
