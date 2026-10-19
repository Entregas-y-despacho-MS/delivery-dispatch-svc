import { BadRequestException } from '@nestjs/common';

export class InvalidRescheduleWindowException extends BadRequestException {
    constructor(message: string) {
        super({ message, error: 'INVALID_RESCHEDULE_WINDOW' });
    }
}
