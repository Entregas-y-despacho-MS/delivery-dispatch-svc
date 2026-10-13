import { Injectable } from '@nestjs/common';
import { TaskRunLog, type TaskRunRecord } from '../ports/task-run-log.port.js';

/** In-memory `TaskRunLog` for tests; instances that must see each other share the same `runs` array. */
@Injectable()
export class MemoryTaskRunLog extends TaskRunLog {
    constructor(readonly runs: TaskRunRecord[] = []) {
        super();
    }

    async wasRecorded(occurrence: string): Promise<boolean> {
        return this.runs.some((run) => run.occurrence === occurrence);
    }

    async record(run: TaskRunRecord): Promise<void> {
        this.runs.push(run);
    }
}
