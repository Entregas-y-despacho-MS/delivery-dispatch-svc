// Must match dispatch_statuses.name exactly (delivery-dispatch-db/schema/dispatch/dispatch_statuses/data.sql).
export enum DispatchStatusEnum {
    PENDING       = 'pending',
    IN_TRANSIT    = 'in_transit',
    DELIVERED     = 'delivered',
    NOT_DELIVERED = 'not_delivered',
    RETURNED      = 'returned',
}
