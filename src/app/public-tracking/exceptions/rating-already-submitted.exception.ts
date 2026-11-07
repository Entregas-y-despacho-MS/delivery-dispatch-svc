import { ConflictException } from '@nestjs/common';

export class RatingAlreadySubmittedException extends ConflictException {
    constructor() {
        super({ message: 'This delivery has already been rated.', error: 'RATING_ALREADY_SUBMITTED' });
    }
}
