export const DISPATCH_STATUS_CHANGED_EVENT = 'dispatch.status_changed';

export interface DispatchStatusChangedEvent {
    dispatchId: number;
    status: string;
    previousStatus: string;
    /** Planning version; driver transitions intentionally leave it unchanged. */
    version: number;
    updatedAt: string;
}
