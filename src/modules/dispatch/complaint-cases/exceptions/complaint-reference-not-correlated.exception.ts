import { UnprocessableEntityException } from '@nestjs/common';

export class ComplaintReferenceNotCorrelatedException extends UnprocessableEntityException {
    constructor() {
        super({
            message: 'The case does not match a delivery dispatch with the same tracking code, so it cannot be investigated.',
            error: 'COMPLAINT_REFERENCE_NOT_CORRELATED',
        });
    }
}
