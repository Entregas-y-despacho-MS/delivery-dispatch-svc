import { ConflictException, UnprocessableEntityException } from '@nestjs/common';

export class SupplierPickupConflictException extends ConflictException {
    constructor(code: string, message: string) { super({ message, error: code }); }
}

export class SupplierPickupEvidenceRequiredException extends UnprocessableEntityException {
    constructor() { super({ message: 'A reasonCode and a photo already registered for this dispatch are required when a received quantity differs from the expected one.', error: 'SUPPLIER_PICKUP_EVIDENCE_REQUIRED' }); }
}

export class ReturnPickupObservationsRequiredException extends UnprocessableEntityException {
    constructor() { super({ message: 'observations are required when any checklist point is unchecked.', error: 'RETURN_PICKUP_OBSERVATIONS_REQUIRED' }); }
}

export class ReturnPickupPhotoRequiredException extends UnprocessableEntityException {
    constructor() { super({ message: 'photoId must reference a photo already registered for this dispatch.', error: 'RETURN_PICKUP_PHOTO_REQUIRED' }); }
}

export class ReturnPickupSignatureRequiredException extends UnprocessableEntityException {
    constructor() { super({ message: 'signatureId must reference a signature already registered for this dispatch.', error: 'RETURN_PICKUP_SIGNATURE_REQUIRED' }); }
}

export class SupplierPickupSignatureRequiredException extends UnprocessableEntityException {
    constructor() { super({ message: 'signatureId must reference a signature already registered for this dispatch.', error: 'SUPPLIER_PICKUP_SIGNATURE_REQUIRED' }); }
}
