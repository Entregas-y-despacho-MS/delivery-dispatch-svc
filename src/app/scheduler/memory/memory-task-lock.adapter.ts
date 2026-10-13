import { Injectable } from '@nestjs/common';
import { TaskLock, type ExclusiveResult } from '../ports/task-lock.port.js';

/**
 * In-memory `TaskLock` for tests. Two "instances" are two adapters that share the same `held` set,
 * which is the in-memory equivalent of two backends talking to the same PostgreSQL.
 */
@Injectable()
export class MemoryTaskLock extends TaskLock {
    constructor(private readonly held: Set<string> = new Set()) {
        super();
    }

    async runExclusive<T>(taskName: string, work: () => Promise<T>): Promise<ExclusiveResult<T>> {
        if (this.held.has(taskName)) return { acquired: false };
        this.held.add(taskName);
        try {
            return { acquired: true, value: await work() };
        } finally {
            this.held.delete(taskName);
        }
    }
}
