import { NotFoundException } from '@nestjs/common';

export class UserNotFoundException extends NotFoundException {
    constructor() {
        super({ message: 'User not found.', error: 'USER_NOT_FOUND' });
    }
}
