import { ConflictException } from '@nestjs/common';

/** The dispatch has no pending change request: the customer did not ask, it was already resolved, or it is on the road. */
export class ChangeRequestNotPendingException extends ConflictException {
    constructor() {
        super({ message: 'The dispatch has no pending change request.', error: 'CHANGE_REQUEST_NOT_PENDING' });
    }
}
