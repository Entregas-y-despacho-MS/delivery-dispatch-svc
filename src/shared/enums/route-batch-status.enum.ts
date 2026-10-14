// Must match the route_batches.status CHECK (delivery-dispatch-db migration 013).
export enum RouteBatchStatusEnum {
    PROVISIONAL          = 'provisional',
    PENDING_FINAL_REVIEW = 'pending_final_review',
    CONFIRMED            = 'confirmed',
    IN_EXECUTION         = 'in_execution',
    CLOSED               = 'closed',
    CANCELLED            = 'cancelled',
}
