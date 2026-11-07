import { ConflictException } from '@nestjs/common';

export class RatingNotAllowedException extends ConflictException {
    constructor() {
        super({ message: 'This delivery cannot be rated yet.', error: 'RATING_NOT_ALLOWED' });
    }
}
