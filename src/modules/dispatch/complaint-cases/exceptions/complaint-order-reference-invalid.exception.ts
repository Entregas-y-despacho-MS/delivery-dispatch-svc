import { UnprocessableEntityException } from '@nestjs/common';

export class ComplaintOrderReferenceInvalidException extends UnprocessableEntityException {
    constructor() {
        super({
            message: 'The order reference of the dispatch is longer than 64 characters, so the RMA authorization request cannot be sent to Inventory.',
            error: 'COMPLAINT_ORDER_REFERENCE_INVALID',
        });
    }
}
