import { NotFoundException } from '@nestjs/common';

export class WarehouseNotFoundException extends NotFoundException {
    constructor() {
        super({ message: 'Warehouse not found.', error: 'WAREHOUSE_NOT_FOUND' });
    }
}
