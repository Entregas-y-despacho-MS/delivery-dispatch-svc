import { BadRequestException } from '@nestjs/common';

export class InvalidPickupWindowException extends BadRequestException {
    constructor(message: string) {
        super({ message, error: 'INVALID_PICKUP_WINDOW' });
    }
}
