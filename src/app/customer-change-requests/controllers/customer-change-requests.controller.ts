import { Controller, Get, Header, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CoordinatorOnly, Roles } from '../../auth/decorators/index.js';
import { CurrentUser } from '../../../shared/decorators/current-user.decorator.js';
import { RoleEnum } from '../../../shared/enums/index.js';
import { ParseIdPipe } from '../../../shared/pipes/index.js';
import { ApiBadRequests, ApiConflict, ApiForbidden, ApiIdParam, ApiNotFound, ApiUnauthorized } from '../../../shared/utils/swagger/index.js';
import { FindChangeRequestsResponseDto } from '../dto/change-request-item.dto.js';
import { FindChangeRequestsParamsDto } from '../dto/find-change-requests-params.dto.js';
import { TrackingLinkDto } from '../dto/tracking-link.dto.js';
import { CustomerChangeRequestsService } from '../services/customer-change-requests.service.js';
import { TrackingLinkRevealService } from '../services/tracking-link-reveal.service.js';

/**
 * ST-224.1 (extension for ES-227) — the coordinator's tray of change requests that customers left from their tracking link.
 *
 * Error dictionary: INVALID_TOKEN 401, INSUFFICIENT_PERMISSIONS 403, DISPATCH_NOT_FOUND 404,
 *   CHANGE_REQUEST_NOT_PENDING 409, TRACKING_LINK_NOT_AVAILABLE 409
 */
@ApiTags('Dispatches')
@ApiBearerAuth('access-token')
@Controller('dispatches/change-requests')
export class CustomerChangeRequestsController {
    constructor(
        private readonly service: CustomerChangeRequestsService,
        private readonly links: TrackingLinkRevealService,
    ) {}

    @Get()
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary: 'List the change requests left by customers',
        description: 'Lists the deliveries whose customer asked for a change from the tracking link and that nobody has resolved yet: `customer_confirmation = change_requested` and still `scheduled` or `assigned`. The oldest request comes first. Each item says what the customer wrote and when, whether their 12 h response window was still open, whether the promise is already firm (if it is not, no preparation order goes out until the request is resolved), where the delivery is now (route, date, slot, zone) and whether the order has an email. Filters: `delivery_zone_id`, `date` (date of the route) and `search` (tracking code or contact name). A request is resolved with `POST /dispatches/:id/reschedule`, which takes it out of this list. The list never contains the tracking link: for a customer without email, a coordinator can ask for it with `POST /dispatches/change-requests/:id/tracking-link` (`canRevealTrackingLink` says whether that is possible). Requires coordinator or supervisor role, or root.',
    })
    @ApiOkResponse({ type: FindChangeRequestsResponseDto })
    @ApiBadRequests({ validation: true, example: ["The 'delivery_zone_id' parameter must be an integer."] })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    async findAll(@Query() params: FindChangeRequestsParamsDto, @CurrentUser('role') role: RoleEnum): Promise<FindChangeRequestsResponseDto> {
        return await this.service.findAll(params, role);
    }

    @Post(':id/tracking-link')
    @HttpCode(HttpStatus.OK)
    @Header('Cache-Control', 'no-store')
    @CoordinatorOnly()
    @ApiOperation({
        summary: 'Show the tracking link of a customer without email',
        description: 'Returns the tracking page of the customer (`trackingUrl`) so the coordinator can share it by another channel (ES-227). It is the only credential of the customer, so it is never part of the list and it is only shown when all of this holds: the dispatch has a pending change request, the order has no email (a customer with an email already received it there) and the token has not expired. Every time it is shown the event `tracking_link_revealed` is recorded on the dispatch with the coordinator and the time, never with the link. 409 `CHANGE_REQUEST_NOT_PENDING` when there is no pending request; 409 `TRACKING_LINK_NOT_AVAILABLE` with `details.reason` `has_contact_email` or `no_live_token`. Requires coordinator role, or root; the supervisor can read the list but not the link.',
    })
    @ApiIdParam('Dispatch')
    @ApiOkResponse({ type: TrackingLinkDto })
    @ApiBadRequests({ id: true })
    @ApiNotFound({ code: 'DISPATCH_NOT_FOUND', message: 'Dispatch not found.' })
    @ApiConflict(
        { code: 'CHANGE_REQUEST_NOT_PENDING', message: 'The dispatch has no pending change request.' },
        { code: 'TRACKING_LINK_NOT_AVAILABLE', message: 'The tracking link of this customer cannot be shown.' },
    )
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    async revealTrackingLink(@Param('id', ParseIdPipe) id: number, @CurrentUser('id') userId: number): Promise<TrackingLinkDto> {
        return await this.links.reveal(id, userId);
    }
}
