import { ConflictException, UnprocessableEntityException } from '@nestjs/common';

export class SupplierPickupConflictException extends ConflictException {
    constructor(code: string, message: string) { super({ message, error: code }); }
}

export class SupplierPickupEvidenceRequiredException extends UnprocessableEntityException {
    constructor() { super({ message: 'A reasonCode and a photo already registered for this dispatch are required when a received quantity differs from the expected one.', error: 'SUPPLIER_PICKUP_EVIDENCE_REQUIRED' }); }
}
