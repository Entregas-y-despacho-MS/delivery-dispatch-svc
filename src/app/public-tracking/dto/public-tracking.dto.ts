import { ApiProperty } from '@nestjs/swagger';
import type { SelfServiceClosedReason } from '../domain/self-service.js';

const CLOSED_REASONS: SelfServiceClosedReason[] = [
    'not_open', 'change_requested', 'no_valid_notice', 'window_elapsed', 'confirmed', 'max_attempts',
];

export class SelfServiceDto {
    @ApiProperty({ description: 'The customer can still answer the promise on their own: the response window has not elapsed, they have not confirmed and they have rescheduling attempts left.' })
    open!: boolean;

    @ApiProperty({
        enum: CLOSED_REASONS, nullable: true, type: String,
        description: 'Why the self-service is over; `null` while it is open. `not_open`: the order is not in the promised state; `no_valid_notice`: the notice never reached the customer, so the response window never started; `window_elapsed`, `confirmed`, `max_attempts` and `change_requested` are the other ends. After it only `canRequestChange` can be true.',
    })
    closedReason!: SelfServiceClosedReason | null;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'When the original response window ends (first valid notice plus `promise_response_window_minutes`). It never moves, not even after a rescheduling. `null` while there is no valid notice.' })
    windowClosesAt!: Date | null;

    @ApiProperty({ type: 'integer', description: 'Reschedulings the customer can still make (`max_reschedule_attempts` minus the ones already used).' })
    rescheduleAttemptsLeft!: number;

    @ApiProperty({ description: 'The customer can confirm the promise now. Confirming ends the self-service.' })
    canConfirm!: boolean;

    @ApiProperty({ description: 'The customer can ask for a verification code and choose another slot. False when the self-service is over, when there is no email to send the code to, or when the rescheduling is not configured yet.' })
    canReschedule!: boolean;

    @ApiProperty({ description: 'The customer can leave a change request for the coordinator to decide. It is the only action left once the self-service is over.' })
    canRequestChange!: boolean;
}

export class PublicTrackingDto {
    @ApiProperty({ type: String, nullable: true, description: 'Tracking code printed on the order. It identifies the delivery but never gives access to this page.' })
    trackingCode!: string | null;

    @ApiProperty({ description: 'Current state of the delivery (`dispatch_statuses.name`), for example `scheduled`, `assigned`, `out_for_delivery` or `delivered`.' })
    status!: string;

    @ApiProperty({ description: 'Whether the customer has answered the promise: `pending`, `confirmed`, `rescheduled` or `change_requested`.' })
    customerConfirmation!: string;

    @ApiProperty({ type: String, format: 'date', nullable: true, description: 'Local date of the delivery (`YYYY-MM-DD`). `null` while the order has no route.' })
    deliveryDate!: string | null;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'Start of the promised delivery slot. `null` while there is none.' })
    windowStart!: Date | null;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'End of the promised delivery slot. `null` while there is none.' })
    windowEnd!: Date | null;

    @ApiProperty({ type: () => SelfServiceDto, description: 'What the customer can do from this link right now.' })
    selfService!: SelfServiceDto;
}
