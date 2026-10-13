import { NotFoundException } from '@nestjs/common';

export class RouteBatchNotFoundException extends NotFoundException {
    constructor() {
        super({ message: 'Route batch not found.', error: 'ROUTE_BATCH_NOT_FOUND' });
    }
}
