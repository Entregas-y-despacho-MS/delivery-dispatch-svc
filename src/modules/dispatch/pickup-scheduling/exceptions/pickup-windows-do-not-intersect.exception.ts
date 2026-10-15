import { ConflictException } from '@nestjs/common';

export class PickupWindowsDoNotIntersectException extends ConflictException {
    constructor() {
        super({
            message: 'The supplier pickup window and the warehouse reception hours have no common time still ahead.',
            error:   'PICKUP_WINDOWS_DO_NOT_INTERSECT',
        });
    }
}
