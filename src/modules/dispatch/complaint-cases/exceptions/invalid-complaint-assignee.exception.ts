import { BadRequestException } from '@nestjs/common';

export class InvalidComplaintAssigneeException extends BadRequestException {
    constructor() {
        super({
            message: 'The assignee must be an active coordinator or supervisor.',
            error: 'INVALID_COMPLAINT_ASSIGNEE',
        });
    }
}
