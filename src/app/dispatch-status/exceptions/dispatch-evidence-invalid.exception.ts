import { UnprocessableEntityException } from '@nestjs/common';

export type DispatchEvidenceInvalidCode =
    | 'DISPATCH_EVIDENCE_NOT_FOUND'
    | 'DISPATCH_EVIDENCE_FOREIGN'
    | 'DISPATCH_EVIDENCE_TYPE_MISMATCH'
    | 'DISPATCH_EVIDENCE_INCOMPLETE';

/** The evidence the app presented for `delivered` exists as a reference but cannot back the delivery (ST-304.2). */
export class DispatchEvidenceInvalidException extends UnprocessableEntityException {
    constructor(code: DispatchEvidenceInvalidCode, message: string) {
        super({ message, error: code });
    }
}
