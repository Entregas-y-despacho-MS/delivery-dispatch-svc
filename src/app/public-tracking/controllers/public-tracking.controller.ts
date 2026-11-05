import { Body, Controller, Get, Header, HttpCode, Headers, Param, Post } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../auth/decorators/index.js';
import { ApiBadRequests, ApiConflict, ApiForbidden, ApiNotFound, errorBody } from '../../../shared/utils/swagger/index.js';
import { PUBLIC_TRACKING_LIMIT, PUBLIC_TRACKING_TTL_MS } from '../config/throttle.js';
import { AvailableSlotsDto } from '../dto/available-slots.dto.js';
import { ChangeRequestDto } from '../dto/change-request.dto.js';
import { RescheduleDto } from '../dto/reschedule.dto.js';
import { PublicTrackingDto } from '../dto/public-tracking.dto.js';
import { VerificationCodeSentDto, VerificationProofDto, VerifyCodeDto } from '../dto/verification.dto.js';
import { CustomerRescheduleService } from '../services/customer-reschedule.service.js';
import { CustomerResponseService } from '../services/customer-response.service.js';
import { PublicTrackingService } from '../services/public-tracking.service.js';
import { SlotOfferService } from '../services/slot-offer.service.js';
import { VerificationCodeService } from '../services/verification-code.service.js';

const TOKEN_PARAM = { name: 'token', description: 'Tracking token of the link sent by email (not the tracking code).' };
const TOO_MANY_REQUESTS = {
    status: 429,
    description: 'Too many requests from this IP. Wait and try again; the answer is the same whether or not the token exists.',
    schema: { example: errorBody(429, 'TOO_MANY_REQUESTS', 'ThrottlerException: Too Many Requests') },
};
const RESCHEDULE_NOT_AVAILABLE = {
    code: 'RESCHEDULE_NOT_AVAILABLE',
    message: 'Rescheduling is not available for this delivery.',
};

/**
 * RF-U14 / RF-U21 — the customer's page, opened from the link of the promise email (ST-224.1). No login:
 * the `tracking_token` in the URL is the only credential, and the `tracking_code` never opens it.
 *
 * Every route here is `@Public()` and limited per client IP with the same budget whether the token exists or
 * not; a link that does not work always answers the same 404, so nothing reveals whether a token exists.
 *
 * Error dictionary: TRACKING_LINK_NOT_FOUND 404, TOO_MANY_REQUESTS 429,
 *   RESCHEDULE_NOT_AVAILABLE 409, VERIFICATION_CODE_RATE_LIMITED 429,
 *   INVALID_VERIFICATION_CODE 400, VERIFICATION_CODE_EXPIRED 400,
 *   VERIFICATION_CODE_NOT_SENT 503, VERIFICATION_UNAVAILABLE 503,
 *   CONFIRMATION_NOT_AVAILABLE 409, CHANGE_REQUEST_NOT_AVAILABLE 409,
 *   VERIFICATION_REQUIRED 403, OSRM_UNAVAILABLE 503, SLOT_NO_LONGER_AVAILABLE 409
 */
@ApiTags('Public tracking')
@Public()
@Throttle({ default: { limit: PUBLIC_TRACKING_LIMIT, ttl: PUBLIC_TRACKING_TTL_MS } })
@Controller('public/tracking')
export class PublicTrackingController {
    constructor(
        private readonly service: PublicTrackingService,
        private readonly verification: VerificationCodeService,
        private readonly responses: CustomerResponseService,
        private readonly slots: SlotOfferService,
        private readonly rescheduling: CustomerRescheduleService,
    ) {}

    @Get(':token')
    @Header('Cache-Control', 'no-store')
    @ApiOperation({
        summary: 'View a delivery from its tracking link',
        description: 'Public, no login. Returns the state, the delivery date and slot, and what the customer can still do (`selfService`): confirm, reschedule or ask for a change. While the delivery is on its way it also returns the estimated arrival (`eta`, from OSRM or, when OSRM cannot answer, the promised slot: `source: window`; kept for 60 seconds per delivery), who delivers (`driver`: name, vehicle type and plate) and, only when it is this customer\'s turn (`in_transit`), the last position of the driver (`location`); all three are `null` in any other state. The `token` of the link is the only credential; the tracking code never gives access. The page shows the minimum: no address, no phone (of the customer or the driver), no email, delivery OTP or proof photos. An unknown, malformed or expired token answers the same 404, and each client IP has a request limit (429).',
    })
    @ApiParam(TOKEN_PARAM)
    @ApiOkResponse({ type: PublicTrackingDto })
    @ApiNotFound({ code: 'TRACKING_LINK_NOT_FOUND', message: 'Tracking link not found.' })
    @ApiResponse(TOO_MANY_REQUESTS)
    async view(@Param('token') token: string): Promise<PublicTrackingDto> {
        return await this.service.view(token);
    }

    @Post(':token/verification-code')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    @ApiOperation({
        summary: 'Send the verification code to the registered email',
        description: 'Public, no login. Starts the rescheduling: sends a 6-digit code (not the delivery OTP) to the email registered on the order and answers a partly hidden version of it. The code lasts `reschedule_code_expiry_minutes`; asking again issues a new one and the previous one stops working, at most 3 times per 15 minutes. Only while the self-service is open (`selfService.canReschedule`): 409 `RESCHEDULE_NOT_AVAILABLE` with the `reason` otherwise. The code is never returned and never stored in clear.',
    })
    @ApiParam(TOKEN_PARAM)
    @ApiOkResponse({ type: VerificationCodeSentDto })
    @ApiNotFound({ code: 'TRACKING_LINK_NOT_FOUND', message: 'Tracking link not found.' })
    @ApiConflict(RESCHEDULE_NOT_AVAILABLE)
    @ApiResponse({
        status: 429,
        description: 'Too many requests from this IP (`TOO_MANY_REQUESTS`) or too many codes requested for this delivery (`VERIFICATION_CODE_RATE_LIMITED`).',
        schema: { example: errorBody(429, 'VERIFICATION_CODE_RATE_LIMITED', 'Too many verification codes were requested. Wait a few minutes and try again.') },
    })
    @ApiServiceUnavailableResponse({
        description: 'The email could not be sent (`VERIFICATION_CODE_NOT_SENT`) or the store of codes is down (`VERIFICATION_UNAVAILABLE`). Try again in a moment.',
        schema: { example: errorBody(503, 'VERIFICATION_CODE_NOT_SENT', 'The verification code could not be sent. Try again in a moment.') },
    })
    async sendCode(@Param('token') token: string): Promise<VerificationCodeSentDto> {
        return await this.verification.send(await this.service.resolve(token));
    }

    @Post(':token/verification-code/verify')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    @ApiOperation({
        summary: 'Check the verification code and get the proof to reschedule',
        description: 'Public, no login. Checks the 6-digit code the customer received and answers a one-time `proof`, which goes in the `X-Verification-Proof` header of the requests that list slots and reschedule. A wrong code spends one of 5 attempts (400 `INVALID_VERIFICATION_CODE` with `attemptsLeft`); with none left, or when the code expired or was already used, the answer is 400 `VERIFICATION_CODE_EXPIRED` and a new code must be requested.',
    })
    @ApiParam(TOKEN_PARAM)
    @ApiOkResponse({ type: VerificationProofDto })
    @ApiBadRequests({
        validation: true,
        example: ['code must be exactly 6 digits.'],
        errors: [
            { code: 'INVALID_VERIFICATION_CODE', message: 'The verification code is not correct.' },
            { code: 'VERIFICATION_CODE_EXPIRED', message: 'There is no valid verification code. Request a new one.' },
        ],
    })
    @ApiNotFound({ code: 'TRACKING_LINK_NOT_FOUND', message: 'Tracking link not found.' })
    @ApiConflict(RESCHEDULE_NOT_AVAILABLE)
    @ApiResponse(TOO_MANY_REQUESTS)
    @ApiServiceUnavailableResponse({
        description: 'The store of codes is down (`VERIFICATION_UNAVAILABLE`). Try again in a moment.',
        schema: { example: errorBody(503, 'VERIFICATION_UNAVAILABLE', 'Verification is temporarily unavailable. Try again in a moment.') },
    })
    async verifyCode(@Param('token') token: string, @Body() dto: VerifyCodeDto): Promise<VerificationProofDto> {
        return await this.verification.verify(await this.service.resolve(token), dto.code);
    }

    @Get(':token/slots')
    @Header('Cache-Control', 'no-store')
    @ApiOperation({
        summary: 'List the slots the delivery can be moved to',
        description: 'Public, no login, but it needs the proof of the verification code in the `X-Verification-Proof` header (403 `VERIFICATION_REQUIRED` without it). Lists only slots the plan can really take: open batches of the delivery\'s own zone and warehouse, other than the one it is in, whose cutoff of the day before has not passed, that leave the warehouse its lead time, with an active vehicle that holds the load, and where the route stays feasible without moving any customer already told (the same check the plan generator applies to a late order). One entry per date and time, earliest first. When nothing fits, `slots` is empty with an `unavailableReason` and the page sends the customer to Dispatch. Asks the routing engine: 503 `OSRM_UNAVAILABLE` if it is down. Nothing is changed by listing; the choice is checked again when it is made.',
    })
    @ApiParam(TOKEN_PARAM)
    @ApiHeader({ name: 'x-verification-proof', required: true, description: 'The `proof` returned by the verification of the code. It is not the code and it is not the tracking token.' })
    @ApiOkResponse({ type: AvailableSlotsDto })
    @ApiNotFound({ code: 'TRACKING_LINK_NOT_FOUND', message: 'Tracking link not found.' })
    @ApiForbidden({ code: 'VERIFICATION_REQUIRED', message: 'Verify the code sent to your email first.' })
    @ApiConflict(RESCHEDULE_NOT_AVAILABLE)
    @ApiResponse(TOO_MANY_REQUESTS)
    @ApiServiceUnavailableResponse({
        description: 'The routing engine is down (`OSRM_UNAVAILABLE`) or the store of proofs is (`VERIFICATION_UNAVAILABLE`). Try again in a moment.',
        schema: { example: errorBody(503, 'OSRM_UNAVAILABLE', 'The routing engine is unavailable.') },
    })
    async listSlots(@Param('token') token: string, @Headers('x-verification-proof') proof?: string): Promise<AvailableSlotsDto> {
        return await this.slots.offer(await this.service.resolve(token), proof);
    }

    @Post(':token/reschedule')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    @ApiOperation({
        summary: 'Move the delivery to another slot',
        description: 'Public, no login, with the proof of the verification code in the `X-Verification-Proof` header. The customer chooses one of the slots listed for the delivery (`slotId`) and the delivery moves to it, in one step and keeping its `scheduled` state: it enters the chosen batch and leaves the one it was in, the promise becomes firm (the first time) and the warehouse receives a new preparation order that replaces the previous one. The 12 hours of the customer do not start again. The proof is spent: another rescheduling needs a new code. The choice is checked again when it is made; if the slot cannot be taken any more nothing changes and the answer is 409 `SLOT_NO_LONGER_AVAILABLE`. Allowed while the original response window is open and `max_reschedule_attempts` is not reached (409 `RESCHEDULE_NOT_AVAILABLE` with the `reason` otherwise). The customer gets an email with the new slot. Answers the updated page.',
    })
    @ApiParam(TOKEN_PARAM)
    @ApiHeader({ name: 'x-verification-proof', required: true, description: 'The `proof` returned by the verification of the code. It is spent by a successful rescheduling.' })
    @ApiOkResponse({ type: PublicTrackingDto })
    @ApiBadRequests({ validation: true, example: ['slotId must be one of the ids returned by the list of slots.'] })
    @ApiNotFound({ code: 'TRACKING_LINK_NOT_FOUND', message: 'Tracking link not found.' })
    @ApiForbidden({ code: 'VERIFICATION_REQUIRED', message: 'Verify the code sent to your email first.' })
    @ApiConflict(RESCHEDULE_NOT_AVAILABLE, { code: 'SLOT_NO_LONGER_AVAILABLE', message: 'That slot is no longer available. Choose another one.' })
    @ApiResponse(TOO_MANY_REQUESTS)
    @ApiServiceUnavailableResponse({
        description: 'The routing engine is down (`OSRM_UNAVAILABLE`) or the store of proofs is (`VERIFICATION_UNAVAILABLE`). Nothing was changed; try again in a moment.',
        schema: { example: errorBody(503, 'OSRM_UNAVAILABLE', 'The routing engine is unavailable.') },
    })
    async reschedule(
        @Param('token') token: string,
        @Body() dto: RescheduleDto,
        @Headers('x-verification-proof') proof?: string,
    ): Promise<PublicTrackingDto> {
        return await this.rescheduling.reschedule(token, dto.slotId, proof);
    }

    @Post(':token/confirm')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    @ApiOperation({
        summary: 'Confirm the delivery promise',
        description: 'Public, no login. The customer accepts the date and slot they were promised. The promise becomes firm now (`promise_firmed_at`), the warehouse is asked to prepare the order, and the self-service ends. It does not need the verification code. Only while the self-service is open and the customer has not answered (`selfService.canConfirm`); otherwise 409 `CONFIRMATION_NOT_AVAILABLE` with the `reason`. Sending it twice is safe: the order is queued once. Answers the updated page.',
    })
    @ApiParam(TOKEN_PARAM)
    @ApiOkResponse({ type: PublicTrackingDto })
    @ApiNotFound({ code: 'TRACKING_LINK_NOT_FOUND', message: 'Tracking link not found.' })
    @ApiConflict({ code: 'CONFIRMATION_NOT_AVAILABLE', message: 'The delivery cannot be confirmed from this link.' })
    @ApiResponse(TOO_MANY_REQUESTS)
    async confirm(@Param('token') token: string): Promise<PublicTrackingDto> {
        return await this.responses.confirm(token);
    }

    @Post(':token/change-request')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    @ApiOperation({
        summary: 'Ask the coordinator for a change',
        description: 'Public, no login. The customer leaves what they need (`detail`, up to 500 characters) and the delivery is marked `change_requested`. Nothing is moved: the coordinator decides, and a rescheduling of the coordinator resolves it. It is the only action left once the self-service is over, and it also serves when no slot is available. Allowed while the delivery is `scheduled` or `assigned` and no request is pending (`selfService.canRequestChange`); otherwise 409 `CHANGE_REQUEST_NOT_AVAILABLE`. Answers the updated page.',
    })
    @ApiParam(TOKEN_PARAM)
    @ApiOkResponse({ type: PublicTrackingDto })
    @ApiBadRequests({ validation: true, example: ['detail must not be empty.'] })
    @ApiNotFound({ code: 'TRACKING_LINK_NOT_FOUND', message: 'Tracking link not found.' })
    @ApiConflict({ code: 'CHANGE_REQUEST_NOT_AVAILABLE', message: 'A change cannot be requested for this delivery.' })
    @ApiResponse(TOO_MANY_REQUESTS)
    async requestChange(@Param('token') token: string, @Body() dto: ChangeRequestDto): Promise<PublicTrackingDto> {
        return await this.responses.requestChange(token, dto.detail);
    }
}
