import { UnprocessableEntityException } from '@nestjs/common';

export class DispatchEvidenceRequiredException extends UnprocessableEntityException {
    constructor(evidenceType: string) {
        super({ message: `The delivery requires ${evidenceType} evidence before it can be marked delivered.`, error: 'DISPATCH_EVIDENCE_REQUIRED' });
    }
}
