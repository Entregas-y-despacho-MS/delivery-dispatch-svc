import { ConflictException } from '@nestjs/common';

export class DispatchAlreadyReservedException extends ConflictException {
    constructor(dispatchIds: number[]) {
        super({
            message: `These orders are already being planned by another coordinator: ${dispatchIds.join(', ')}.`,
            error:   'DISPATCH_ALREADY_RESERVED',
        });
    }
}
