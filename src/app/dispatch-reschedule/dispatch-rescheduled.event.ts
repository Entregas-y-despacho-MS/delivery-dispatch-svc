/**
 * Internal event: the coordinator rescheduled a dispatch (ST-52.2). Emitted after the commit so that the
 * customer notice (ES-40, Sprint 3) never observes a rescheduling that rolled back. Nobody consumes it yet.
 * The name is this task's choice: no document fixes it.
 */
export const DISPATCH_RESCHEDULED_EVENT = 'dispatch.rescheduled';

export interface DispatchRescheduledEvent {
    dispatchId: number;
    rescheduleId: number;
    rescheduledBy: 'coordinator';
    reasonCode: string;
    previousStatus: string;
    previousWindowStart: string | null;
    previousWindowEnd: string | null;
    windowStart: string;
    windowEnd: string;
    /** Planning version after the rescheduling. */
    version: number;
}
