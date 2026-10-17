import { ConflictException } from '@nestjs/common';

export class RouteBatchNotCorrectableException extends ConflictException {
  constructor(status: string) {
    super({
      message: `The driver or the vehicle can only be corrected while the route batch is provisional or pending final review (current status: ${status}).`,
      error: 'ROUTE_BATCH_NOT_CORRECTABLE',
    });
  }
}
