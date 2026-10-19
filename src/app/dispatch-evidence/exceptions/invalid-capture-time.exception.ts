import { BadRequestException } from '@nestjs/common';

export class InvalidCaptureTimeException extends BadRequestException {
    constructor() {
        super({ message: 'capturedAt cannot be in the future.', error: 'INVALID_CAPTURE_TIME' });
    }
}
