import { ServiceUnavailableException } from '@nestjs/common';

export class ScheduledTaskNotAvailableException extends ServiceUnavailableException {
    constructor() {
        super({
            message: 'The task is not available: the feature that runs it has not registered it in this service.',
            error:   'SCHEDULED_TASK_NOT_AVAILABLE',
        });
    }
}
