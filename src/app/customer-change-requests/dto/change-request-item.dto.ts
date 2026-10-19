import { ApiProperty } from '@nestjs/swagger';
import { PaginationResponseDto } from '../../../shared/dto/index.js';

export class ChangeRequestDetailDto {
    @ApiProperty({ type: String, nullable: true, description: 'What the customer wrote when asking for the change, in their own words. `null` when the request has no text.' })
    detail!: string | null;

    @ApiProperty({ type: String, format: 'date-time', description: 'When the customer asked for the change.' })
    requestedAt!: Date;

    @ApiProperty({ type: Boolean, nullable: true, description: 'Whether the 12 h response window of the customer was still open when they asked. `null` when the request does not say.' })
    responseWindowWasOpen!: boolean | null;

    @ApiProperty({ type: String, nullable: true, description: 'Why the self-service was over when the customer asked (`window_elapsed`, `confirmed`, `max_attempts`, `no_valid_notice`…); `null` when it was still open or the request does not say.' })
    selfServiceClosedReason!: string | null;
}

export class ChangeRequestItemDto {
    @ApiProperty({ type: 'integer', description: 'Dispatch id. Use it to resolve the request (`POST /dispatches/:id/reschedule`) or to ask for the tracking link.' })
    dispatchId!: number;

    @ApiProperty({ type: String, nullable: true, description: 'Tracking code printed on the order.' })
    trackingCode!: string | null;

    @ApiProperty({ description: 'Current state of the dispatch: `scheduled` or `assigned`.' })
    status!: string;

    @ApiProperty({ type: 'integer', nullable: true, description: 'Route batch the dispatch is in. `null` when it has none.' })
    routeBatchId!: number | null;

    @ApiProperty({ type: String, format: 'date', nullable: true, description: 'Local date of the route (`YYYY-MM-DD`). `null` while it has no route.' })
    deliveryDate!: string | null;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'Start of the promised delivery slot. `null` while there is none.' })
    windowStart!: Date | null;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'End of the promised delivery slot. `null` while there is none.' })
    windowEnd!: Date | null;

    @ApiProperty({ type: 'integer', nullable: true, description: 'Delivery zone id. `null` when the dispatch has no zone.' })
    zoneId!: number | null;

    @ApiProperty({ type: String, nullable: true, description: 'Delivery zone name. `null` when the dispatch has no zone.' })
    zoneName!: string | null;

    @ApiProperty({ type: String, nullable: true, description: 'Name of the customer contact. No address, phone or email is returned.' })
    contactName!: string | null;

    @ApiProperty({ description: 'The order has an email, so the customer already received the tracking link there.' })
    hasContactEmail!: boolean;

    @ApiProperty({ type: () => ChangeRequestDetailDto, description: 'What the customer asked and when.' })
    request!: ChangeRequestDetailDto;

    @ApiProperty({ description: 'The promise is already firm (`promise_firmed_at` is set): the warehouse was asked to prepare the order. If it is not, no preparation order will go out until the coordinator resolves the request, because the 12 h closing ignores a delivery with a pending change request.' })
    promiseIsFirm!: boolean;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'When the promise became firm. `null` while it is not.' })
    promiseFirmedAt!: Date | null;

    @ApiProperty({ description: 'The viewer can ask for the tracking link of this customer (`POST /dispatches/change-requests/:id/tracking-link`): they are a coordinator, the order has no email and the token still works. The link itself is never part of this list.' })
    canRevealTrackingLink!: boolean;
}

export class FindChangeRequestsResponseDto extends PaginationResponseDto<ChangeRequestItemDto> {
    @ApiProperty({ type: () => [ChangeRequestItemDto], description: 'Pending change requests on this page, the oldest first.' })
    declare data: ChangeRequestItemDto[];
}
