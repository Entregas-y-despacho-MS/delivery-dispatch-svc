import { ConflictException } from '@nestjs/common';

export class RouteBatchNotConfirmedException extends ConflictException {
    constructor(status: string) {
        super({ message: `The driver can only accept a confirmed batch (current status: ${status}).`, error: 'ROUTE_BATCH_NOT_CONFIRMED' });
    }
}
