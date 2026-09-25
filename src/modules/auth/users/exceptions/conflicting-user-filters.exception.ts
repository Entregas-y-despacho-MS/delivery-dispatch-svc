import { BadRequestException } from '@nestjs/common';

export class ConflictingUserFiltersException extends BadRequestException {
    constructor() {
        super({ message: "Use either the 'active' or the 'status' filter, not both.", error: 'CONFLICTING_USER_FILTERS' });
    }
}
