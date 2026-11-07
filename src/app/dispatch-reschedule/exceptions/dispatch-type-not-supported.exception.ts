import { ConflictException } from '@nestjs/common';

export class DispatchTypeNotSupportedException extends ConflictException {
    /** `expected` is the type the endpoint serves: `delivery` for the dispatch actions, `warehouse_return_pickup` for pickup orders. */
    constructor(type: string, expected: string = 'delivery') {
        super({
            message: expected === 'delivery'
                ? `Only delivery dispatches can be rescheduled or returned from here (type: ${type}). Pickups are rescheduled from their own flow.`
                : `Only ${expected} dispatches can be handled from here (type: ${type}).`,
            error:   'DISPATCH_TYPE_NOT_SUPPORTED',
        });
    }
}
