import { ConflictException } from '@nestjs/common';

export class SupplierPickupIncompleteException extends ConflictException {
    constructor(missing: string[]) {
        super({
            message: `The supplier pickup cannot be scheduled: missing ${missing.join(", ")}.`,
            error:   'SUPPLIER_PICKUP_INCOMPLETE',
        });
    }
}
