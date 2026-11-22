import { NotFoundException } from '@nestjs/common';

export class ComplaintCaseNotFoundException extends NotFoundException {
    constructor() {
        super({ message: 'Complaint case not found.', error: 'COMPLAINT_CASE_NOT_FOUND' });
    }
}
