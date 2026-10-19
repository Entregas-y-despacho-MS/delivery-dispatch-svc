import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../auth/decorators/index.js';
import { CurrentUser } from '../../../shared/decorators/current-user.decorator.js';
import { RoleEnum } from '../../../shared/enums/index.js';
import { ApiBadRequests, ApiForbidden, ApiUnauthorized } from '../../../shared/utils/swagger/index.js';
import { FindChangeRequestsResponseDto } from '../dto/change-request-item.dto.js';
import { FindChangeRequestsParamsDto } from '../dto/find-change-requests-params.dto.js';
import { CustomerChangeRequestsService } from '../services/customer-change-requests.service.js';

/**
 * ST-224.1 (extension for ES-227) — the coordinator's tray of change requests that customers left from their tracking link.
 *
 * Error dictionary: INVALID_TOKEN 401, INSUFFICIENT_PERMISSIONS 403
 */
@ApiTags('Dispatches')
@ApiBearerAuth('access-token')
@Controller('dispatches/change-requests')
export class CustomerChangeRequestsController {
    constructor(private readonly service: CustomerChangeRequestsService) {}

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
}
