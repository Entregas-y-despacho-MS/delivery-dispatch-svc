import { ConflictException } from '@nestjs/common';

export class ScheduledTaskAlreadyRunningException extends ConflictException {
    constructor() {
        super({
            message: 'The task is already running (started by the schedule, by another request or on another instance). Try again when it finishes.',
            error:   'SCHEDULED_TASK_ALREADY_RUNNING',
        });
    }
}
