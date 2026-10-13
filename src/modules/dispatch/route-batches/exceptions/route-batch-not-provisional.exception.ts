import { ConflictException } from '@nestjs/common';

export class RouteBatchNotProvisionalException extends ConflictException {
    constructor(status: string) {
        super({ message: `The reviewer can only be assigned while the batch is provisional (current status: ${status}).`, error: 'ROUTE_BATCH_NOT_PROVISIONAL' });
    }
}
