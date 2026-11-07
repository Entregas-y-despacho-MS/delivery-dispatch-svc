import { UnprocessableEntityException } from '@nestjs/common';

export class WarehouseNotAvailableException extends UnprocessableEntityException {
    constructor(code: string) {
        super({
            message: `Warehouse ${code} does not exist or is not active.`,
            error:   'WAREHOUSE_NOT_AVAILABLE',
        });
    }
}
