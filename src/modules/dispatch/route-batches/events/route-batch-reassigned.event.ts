export const ROUTE_BATCH_REASSIGNED_EVENT = 'route.batch_reassigned';

/** ES-63 — stops moved between two `in_execution` route batches. Both drivers are notified. */
export interface RouteBatchReassignedEvent {
    fromBatchId: number;
    toBatchId: number;
    fromDriverId: number;
    toDriverId: number;
    dispatchIds: number[];
    fromVersion: number;
    toVersion: number;
    zoneName: string | null;
}
