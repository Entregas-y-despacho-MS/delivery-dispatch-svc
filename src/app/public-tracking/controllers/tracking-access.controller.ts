import { Body, Controller, Get, Header, Headers, HttpCode, Post } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../auth/decorators/index.js';
import { ApiBadRequests, ApiUnauthorized, errorBody } from '../../../shared/utils/swagger/index.js';
import { PUBLIC_TRACKING_LIMIT, PUBLIC_TRACKING_TTL_MS } from '../config/throttle.js';
import {
    AccessCodeAcceptedDto, AccessSessionDto, PublicTrackingSessionViewDto, RequestAccessCodeDto, VerifyAccessCodeDto,
} from '../dto/tracking-access.dto.js';
import { TrackingAccessService } from '../services/tracking-access.service.js';

const RATE_LIMITED = {
    status: 429,
    description: 'Too many requests from this IP (`TOO_MANY_REQUESTS`) or too many tries for this tracking code (`TRACKING_ACCESS_RATE_LIMITED`). The answer is the same whether or not the tracking code exists.',
    schema: { example: errorBody(429, 'TRACKING_ACCESS_RATE_LIMITED', 'Too many attempts. Wait a few minutes and try again.') },
};

/** `GET /view` carries no tracking code, so only the per-IP limit can apply. */
const VIEW_RATE_LIMITED = {
    status: 429,
    description: 'Too many requests from this IP (`TOO_MANY_REQUESTS`). Wait and try again.',
    schema: { example: errorBody(429, 'TOO_MANY_REQUESTS', 'ThrottlerException: Too Many Requests') },
};

/**
 * RF-U14 (ST-309.1, ES-309) — the customer's page opened with the tracking code and a one-time code sent to the
 * registered email. No login. It is the alternative to the link of ST-224.1 (`GET /public/tracking/:token`), which
 * keeps working as it is. The tracking code never opens anything by itself: the session obtained after the one-time code
 * is the credential, and it is limited to one delivery.
 *
 * Error dictionary: INVALID_ACCESS_CODE 400, TRACKING_SESSION_INVALID 401, TRACKING_ACCESS_RATE_LIMITED 429,
 *   TOO_MANY_REQUESTS 429, VERIFICATION_UNAVAILABLE 503
 */
@ApiTags('Public tracking')
@Public()
@Throttle({ default: { limit: PUBLIC_TRACKING_LIMIT, ttl: PUBLIC_TRACKING_TTL_MS } })
@Controller('public/tracking/access')
export class TrackingAccessController {
    constructor(private readonly access: TrackingAccessService) {}

    @Post('code')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    @ApiOperation({
        summary: 'Ask for a code to see a delivery by its tracking code',
        description: 'Public, no login. If the tracking code belongs to a delivery with a registered email, a 6-digit code (not the delivery OTP) is sent to that email; it lasts `reschedule_code_expiry_minutes`. The answer is ALWAYS the same `accepted: true`, with no hint of the email, whether or not the tracking code exists, so nothing reveals it. Asking again replaces the previous code. Limited per IP and per tracking code (3 codes per 15 minutes and a cooldown between two requests); the code is never returned, logged or stored in clear.',
    })
    @ApiOkResponse({ type: AccessCodeAcceptedDto })
    @ApiBadRequests({ validation: true, example: ['trackingCode must not be empty.'] })
    @ApiResponse(RATE_LIMITED)
    @ApiServiceUnavailableResponse({
        description: 'The store of codes is down (`VERIFICATION_UNAVAILABLE`). Try again in a moment.',
        schema: { example: errorBody(503, 'VERIFICATION_UNAVAILABLE', 'Verification is temporarily unavailable. Try again in a moment.') },
    })
    async requestCode(@Body() dto: RequestAccessCodeDto): Promise<AccessCodeAcceptedDto> {
        return await this.access.requestCode(dto.trackingCode);
    }

    @Post('verify')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    @ApiOperation({
        summary: 'Check the code and open a session limited to the delivery',
        description: 'Public, no login. Checks the tracking code and the 6-digit code the customer received and answers an opaque, short-lived `session` limited to that ONE delivery, to send in the `X-Tracking-Session` header. A code works once. Every failure (unknown, expired or already used tracking code or code, wrong code) answers the same 400 `INVALID_ACCESS_CODE`, so nothing reveals whether the tracking code exists; a wrong code spends one of 5 attempts and the 5th failure burns it. Limited per IP and per tracking code (429).',
    })
    @ApiOkResponse({ type: AccessSessionDto })
    @ApiBadRequests({
        validation: true,
        example: ['code must be exactly 6 digits.'],
        errors: [{ code: 'INVALID_ACCESS_CODE', message: 'The tracking code or the verification code is not valid. Request a new code and try again.' }],
    })
    @ApiResponse(RATE_LIMITED)
    @ApiServiceUnavailableResponse({
        description: 'The store of codes is down (`VERIFICATION_UNAVAILABLE`). Try again in a moment.',
        schema: { example: errorBody(503, 'VERIFICATION_UNAVAILABLE', 'Verification is temporarily unavailable. Try again in a moment.') },
    })
    async verify(@Body() dto: VerifyAccessCodeDto): Promise<AccessSessionDto> {
        return await this.access.verify(dto.trackingCode, dto.code);
    }

    @Get('view')
    @Header('Cache-Control', 'no-store')
    @ApiOperation({
        summary: 'View the delivery of a session',
        description: 'Public, no login, with the `session` in the `X-Tracking-Session` header (401 `TRACKING_SESSION_INVALID` without it, or when it is unknown, expired or malformed). Returns only the public fields of the delivery the session was opened for: state, date and slot, and, while it is on its way, the estimated arrival, the driver (name, vehicle type and plate) and, in transit, the last position. No address, phone, email, delivery OTP or proof photos, and nothing to act on (no confirmation, rescheduling, change request, rating or claim). The tracking code is not accepted as a credential.',
    })
    @ApiHeader({ name: 'x-tracking-session', required: true, description: 'The `session` returned by the verification of the code. It is not the tracking code and it is not the tracking token of the link.' })
    @ApiOkResponse({ type: PublicTrackingSessionViewDto })
    @ApiUnauthorized({ code: 'TRACKING_SESSION_INVALID', message: 'The tracking session is not valid or has expired. Verify your tracking code again.' })
    @ApiResponse(VIEW_RATE_LIMITED)
    @ApiServiceUnavailableResponse({
        description: 'The store of sessions is down (`VERIFICATION_UNAVAILABLE`). Try again in a moment.',
        schema: { example: errorBody(503, 'VERIFICATION_UNAVAILABLE', 'Verification is temporarily unavailable. Try again in a moment.') },
    })
    async view(@Headers('x-tracking-session') session?: string): Promise<PublicTrackingSessionViewDto> {
        return await this.access.view(session);
    }
}
