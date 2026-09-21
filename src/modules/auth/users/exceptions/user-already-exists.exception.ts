import { ConflictException } from '@nestjs/common';

export class UserAlreadyExistsException extends ConflictException {
    constructor() {
        super({ message: 'A user with this username or email already exists.', error: 'USER_ALREADY_EXISTS' });
    }
}
