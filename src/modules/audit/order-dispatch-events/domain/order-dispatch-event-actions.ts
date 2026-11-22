/** The business transitions that leave an order/dispatch event (ST-69.2). Returns are not listed: they end in a pickup. */
export const ORDER_DISPATCH_ACTIONS = {
    CREATED: 'dispatch.created',
    ASSIGNED: 'dispatch.assigned',
    DEPARTED: 'dispatch.departed',
    DELIVERY_RESULT: 'dispatch.delivery_result',
    RESCHEDULED: 'dispatch.rescheduled',
    CANCELLED: 'dispatch.cancelled',
    PICKUP_COLLECTED: 'dispatch.pickup_collected',
    WAREHOUSE_RECEIVED: 'dispatch.warehouse_received',
} as const;

export type OrderDispatchAction = (typeof ORDER_DISPATCH_ACTIONS)[keyof typeof ORDER_DISPATCH_ACTIONS];
