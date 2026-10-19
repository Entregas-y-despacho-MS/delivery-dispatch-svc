import { BadRequestException } from '@nestjs/common';

export class EvidenceFileRequiredException extends BadRequestException {
    constructor() {
        super({ message: 'A photo or signature evidence needs its file.', error: 'EVIDENCE_FILE_REQUIRED' });
    }
}
