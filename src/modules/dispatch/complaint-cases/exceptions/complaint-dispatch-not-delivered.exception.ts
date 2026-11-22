import { UnprocessableEntityException } from '@nestjs/common';

export class ComplaintDispatchNotDeliveredException extends UnprocessableEntityException {
    constructor() {
        super({
            message: 'Only a case whose dispatch is delivered can be investigated.',
            error: 'COMPLAINT_DISPATCH_NOT_DELIVERED',
        });
    }
}
