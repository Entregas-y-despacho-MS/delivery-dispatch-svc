import { ApiExtraModels, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { nullableRef } from '../../../modules/dispatch/route-batches/dto/nullable-ref.js';
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

export type EtaSource = 'osrm' | 'window';

export class EtaDto {
    @ApiProperty({ type: 'integer', minimum: 0, description: 'Minutes left until the driver arrives, rounded up. With `source: window` it is the minutes left until the end of the promised slot (never negative).' })
    minutes!: number;

    @ApiProperty({ type: String, format: 'date-time', description: 'When this estimate was calculated. It can be up to 60 seconds old: it is cached per delivery.' })
    calculatedAt!: Date;

    @ApiProperty({ enum: ['osrm', 'window'], type: String, description: '`osrm`: driving time from the last known position through the pending stops before this one. `window`: OSRM is down, there is no position yet or the address has no coordinates, so the promised slot stands in for the estimate.' })
    source!: EtaSource;
}

export class DriverDto {
    @ApiProperty({ description: 'Full name of the driver assigned to the route. No phone or other personal data is returned.' })
    name!: string;

    @ApiProperty({ type: String, nullable: true, description: 'Type of the vehicle (for example `moto` or `camioneta`). `null` when the route has no vehicle.' })
    vehicleType!: string | null;

    @ApiProperty({ type: String, nullable: true, description: 'Licence plate of the vehicle. `null` when the route has no vehicle.' })
    vehiclePlate!: string | null;
}

export class LocationDto {
    @ApiProperty({ type: 'number', format: 'double', minimum: -90, maximum: 90, description: 'Latitude of the last position reported by the driver.' })
    latitude!: number;

    @ApiProperty({ type: 'number', format: 'double', minimum: -180, maximum: 180, description: 'Longitude of the last position reported by the driver.' })
    longitude!: number;

    @ApiProperty({ type: String, format: 'date-time', description: 'When the device recorded that position.' })
    recordedAt!: Date;
}

export class RatingDto {
    @ApiProperty({ type: 'integer', minimum: 1, maximum: 5, description: 'Customer rating for the delivery.' })
    score!: number;

    @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500, description: 'Optional trimmed plain-text comment from the customer; null when omitted or blank.' })
    comment?: string | null;

    @ApiProperty({ type: String, format: 'date-time', description: 'When the customer submitted the rating.' })
    createdAt!: Date;
}

@ApiExtraModels(EtaDto, DriverDto, LocationDto, RatingDto)
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

    @ApiProperty({ ...nullableRef(EtaDto), description: 'Estimated arrival. Only while the delivery is `out_for_delivery` or `in_transit`; `null` otherwise.' })
    eta!: EtaDto | null;

    @ApiProperty({ ...nullableRef(DriverDto), description: 'Who delivers. Only while the delivery is `out_for_delivery` or `in_transit`; `null` otherwise, or when the route has no driver.' })
    driver!: DriverDto | null;

    @ApiProperty({ ...nullableRef(LocationDto), description: 'Last position of the driver. Only while the delivery is `in_transit` (it is this customer\'s turn) and a position was reported; `null` otherwise, including `out_for_delivery`.' })
    location!: LocationDto | null;

    @ApiProperty({ ...nullableRef(RatingDto), description: 'Customer rating, including any comment, available after the delivery is rated. `null` when no rating has been submitted.' })
    rating!: RatingDto | null;

    @ApiProperty({ description: 'Whether this customer may rate the delivered order. False after a rating was submitted or before delivery.' })
    canRate!: boolean;

    @ApiProperty({ type: () => SelfServiceDto, description: 'What the customer can do from this link right now.' })
    selfService!: SelfServiceDto;
}
