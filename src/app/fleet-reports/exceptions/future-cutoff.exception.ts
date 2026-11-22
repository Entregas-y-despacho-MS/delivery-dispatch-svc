import { BadRequestException } from '@nestjs/common';

export class FutureCutoffException extends BadRequestException {
    constructor() {
        super({ message: "The 'cutoff' date must not be after today (Bolivia).", error: 'CUTOFF_IN_FUTURE' });
    }
}
