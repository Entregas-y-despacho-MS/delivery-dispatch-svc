import { InternalServerErrorException } from '@nestjs/common';

export class ScheduledTaskFailedException extends InternalServerErrorException {
    constructor() {
        super({
            message: 'The task failed. Nothing was recorded as done; the cause is in the server log.',
            error:   'SCHEDULED_TASK_FAILED',
        });
    }
}
