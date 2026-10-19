import { ConflictException } from '@nestjs/common';

export class EvidenceIdConflictException extends ConflictException {
    constructor() {
        super({ message: 'This evidenceId already belongs to another dispatch.', error: 'EVIDENCE_ID_CONFLICT' });
    }
}
