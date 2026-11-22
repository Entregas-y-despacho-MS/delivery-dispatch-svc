import { ConflictException } from '@nestjs/common';

export class ComplaintCaseVersionStaleException extends ConflictException {
    constructor(expected: number, current: number) {
        super({
            message: `The case is at version ${current} and the command was issued for version ${expected}. Read the case again before acting on it.`,
            error: 'COMPLAINT_CASE_VERSION_STALE',
        });
    }
}
