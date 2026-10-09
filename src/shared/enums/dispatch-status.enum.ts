// Must match dispatch_statuses.name exactly (delivery-dispatch-db/schema/dispatch/dispatch_statuses/data.sql).
export enum DispatchStatusEnum {
    PENDING               = 'pending',
    IN_TRANSIT            = 'in_transit',
    DELIVERED             = 'delivered',
    NOT_DELIVERED         = 'not_delivered',
    RETURNED              = 'returned',
    ADDRESS_REVIEW        = 'address_review',
    IN_PLANNING           = 'in_planning',
    SCHEDULED             = 'scheduled',
    ASSIGNED              = 'assigned',
    OUT_FOR_DELIVERY      = 'out_for_delivery',
    INCIDENT              = 'incident',
    RESCHEDULED           = 'rescheduled',
    PICKUP_SCHEDULED      = 'pickup_scheduled',
    PICKED_UP_IN_TRANSIT  = 'picked_up_in_transit',
    RETURNED_TO_WAREHOUSE = 'returned_to_warehouse',
}
