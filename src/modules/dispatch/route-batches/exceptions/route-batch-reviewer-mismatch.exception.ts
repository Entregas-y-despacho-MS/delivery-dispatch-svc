import { ForbiddenException } from '@nestjs/common';

export class RouteBatchReviewerMismatchException extends ForbiddenException {
    constructor() {
        super({ error: 'ROUTE_BATCH_REVIEWER_MISMATCH', message: 'Only the assigned reviewer can approve this provisional batch.' });
    }
}
