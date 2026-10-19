import { UnsupportedMediaTypeException } from '@nestjs/common';

export class UnsupportedEvidenceFileTypeException extends UnsupportedMediaTypeException {
    constructor(expected: string) {
        super({ message: `The file must be a ${expected} image.`, error: 'UNSUPPORTED_EVIDENCE_FILE_TYPE' });
    }
}
