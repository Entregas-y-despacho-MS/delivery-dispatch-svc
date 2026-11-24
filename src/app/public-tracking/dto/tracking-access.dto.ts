import { ApiExtraModels, ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { nullableRef } from '../../../modules/dispatch/route-batches/dto/nullable-ref.js';
import { DriverDto, EtaDto, LocationDto } from './public-tracking.dto.js';

/**
 * The shape of the tracking code is NOT validated here on purpose: a code that is not shaped like one is answered
 * exactly like an unknown one, so a 400 for its format would be the only different answer. Only size and type.
 */
export class RequestAccessCodeDto {
    @ApiProperty({ example: 'DSP-2026-00001', description: 'Tracking code printed on the order. It only says where the verification code is sent: it never gives access by itself.' })
    @IsString({ message: 'trackingCode must be a string.' })
    @MinLength(1, { message: 'trackingCode must not be empty.' })
    @MaxLength(40, { message: 'trackingCode must not be longer than 40 characters.' })
    trackingCode!: string;
}

export class VerifyAccessCodeDto extends RequestAccessCodeDto {
    @ApiProperty({ example: '482913', description: 'The 6-digit code the customer received in the registered email. It is not the delivery OTP.' })
    @IsString({ message: 'code must be a string.' })
    @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits.' })
    code!: string;
}

export class AccessCodeAcceptedDto {
    @ApiProperty({ example: true, description: 'Always true when the request was understood. It does NOT mean the tracking code exists: a code is sent only when it does and it has a registered email, and the answer is the same otherwise.' })
    accepted!: boolean;

    @ApiProperty({ type: 'integer', example: 600, description: 'Seconds a code lasts once sent (`reschedule_code_expiry_minutes`). The same figure for any tracking code.' })
    expiresInSeconds!: number;
}

export class AccessSessionDto {
    @ApiProperty({ description: 'Opaque, short-lived credential limited to ONE delivery. Send it in the `X-Tracking-Session` header, never in a URL, and keep it out of logs. It is not the tracking code and it is not the tracking token of the link.' })
    session!: string;

    @ApiProperty({ type: String, format: 'date-time', description: 'When the session stops working. After that the customer verifies again.' })
    expiresAt!: Date;
}

/** What the customer sees through a session: the public fields only, and no action (no confirm, rescheduling, change, rating or claim). */
@ApiExtraModels(EtaDto, DriverDto, LocationDto)
export class PublicTrackingSessionViewDto {
    @ApiProperty({ type: String, nullable: true, description: 'Tracking code of the delivery.' })
    trackingCode!: string | null;

    @ApiProperty({ description: 'Current state of the delivery (`dispatch_statuses.name`), for example `scheduled`, `assigned`, `out_for_delivery` or `delivered`.' })
    status!: string;

    @ApiProperty({ type: String, format: 'date', nullable: true, description: 'Local date of the delivery (`YYYY-MM-DD`). `null` while the order has no route.' })
    deliveryDate!: string | null;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'Start of the promised delivery slot. `null` while there is none.' })
    windowStart!: Date | null;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'End of the promised delivery slot. `null` while there is none.' })
    windowEnd!: Date | null;

    @ApiProperty({ ...nullableRef(EtaDto), description: 'Estimated arrival. Only while the delivery is `out_for_delivery` or `in_transit`; `null` otherwise.' })
    eta!: EtaDto | null;

    @ApiProperty({ ...nullableRef(DriverDto), description: 'Who delivers. Only while the delivery is `out_for_delivery` or `in_transit`; `null` otherwise. No phone.' })
    driver!: DriverDto | null;

    @ApiProperty({ ...nullableRef(LocationDto), description: 'Last position of the driver. Only while the delivery is `in_transit`; `null` otherwise.' })
    location!: LocationDto | null;
}
