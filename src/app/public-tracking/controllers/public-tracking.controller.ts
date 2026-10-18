import { Controller, Get, Header, Param } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../auth/decorators/index.js';
import { ApiNotFound, errorBody } from '../../../shared/utils/swagger/index.js';
import { PUBLIC_TRACKING_LIMIT, PUBLIC_TRACKING_TTL_MS } from '../config/throttle.js';
import { PublicTrackingDto } from '../dto/public-tracking.dto.js';
import { PublicTrackingService } from '../services/public-tracking.service.js';

/**
 * RF-U14 / RF-U21 — the customer's page, opened from the link of the promise email (ST-224.1). No login:
 * the `tracking_token` in the URL is the only credential, and the `tracking_code` never opens it.
 *
 * Every route here is `@Public()` and limited per client IP with the same budget whether the token exists or
 * not; a link that does not work always answers the same 404, so nothing reveals whether a token exists.
 *
 * Error dictionary: TRACKING_LINK_NOT_FOUND 404, TOO_MANY_REQUESTS 429
 */
@ApiTags('Public tracking')
@Public()
@Throttle({ default: { limit: PUBLIC_TRACKING_LIMIT, ttl: PUBLIC_TRACKING_TTL_MS } })
@Controller('public/tracking')
export class PublicTrackingController {
    constructor(private readonly service: PublicTrackingService) {}

    @Get(':token')
    @Header('Cache-Control', 'no-store')
    @ApiOperation({
        summary: 'View a delivery from its tracking link',
        description: 'Public, no login. Returns the state, the delivery date and slot, and what the customer can still do (`selfService`): confirm, reschedule or ask for a change. The `token` of the link is the only credential; the tracking code never gives access. The page shows the minimum: no address, phone, delivery OTP or proof photos. An unknown, malformed or expired token answers the same 404, and each client IP has a request limit (429).',
    })
    @ApiParam({ name: 'token', description: 'Tracking token of the link sent by email (not the tracking code).' })
    @ApiOkResponse({ type: PublicTrackingDto })
    @ApiNotFound({ code: 'TRACKING_LINK_NOT_FOUND', message: 'Tracking link not found.' })
    @ApiResponse({
        status: 429,
        description: 'Too many requests from this IP. Wait and try again; the answer is the same whether or not the token exists.',
        schema: { example: errorBody(429, 'TOO_MANY_REQUESTS', 'ThrottlerException: Too Many Requests') },
    })
    async view(@Param('token') token: string): Promise<PublicTrackingDto> {
        return await this.service.view(token);
    }
}
