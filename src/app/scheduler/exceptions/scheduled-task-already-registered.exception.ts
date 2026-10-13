/** Programming error caught at startup: two features registered a task with the same name. */
export class ScheduledTaskAlreadyRegisteredException extends Error {
    constructor(taskName: string) {
        super(`A scheduled task named "${taskName}" is already registered.`);
        this.name = 'ScheduledTaskAlreadyRegisteredException';
    }
}
