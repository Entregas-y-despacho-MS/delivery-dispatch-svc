import { ConflictException } from '@nestjs/common';

export class DispatchStatusConflictException extends ConflictException {
    constructor(code: string, message: string) {
        super({ message, error: code });
    }
}
