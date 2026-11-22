import { ConflictException } from '@nestjs/common';

export class InvalidComplaintTransitionException extends ConflictException {
    constructor(action: string, status: string) {
        super({
            message: `The command '${action}' is not allowed while the case is '${status}'.`,
            error: 'INVALID_COMPLAINT_TRANSITION',
        });
    }
}
