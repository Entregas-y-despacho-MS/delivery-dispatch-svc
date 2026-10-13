import { ConflictException } from '@nestjs/common';

export class RouteBatchReviewerNotEligibleException extends ConflictException {
    constructor() {
        super({ message: 'The reviewer must be an active coordinator or supervisor.', error: 'ROUTE_BATCH_REVIEWER_NOT_ELIGIBLE' });
    }
}
