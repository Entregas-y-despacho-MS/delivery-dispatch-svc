import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PendingOrdersService } from '../services/pending-orders.service.js';
import { FindPendingOrdersParamsDto } from '../dto/find-pending-orders-params.dto.js';
import { FindPendingOrdersResponseDto } from '../dto/pending-order.dto.js';
import { ApiBadRequests, ApiUnauthorized } from '../../../../shared/utils/swagger/index.js';
import { Roles } from '../../../../app/auth/decorators/index.js';
import { RoleEnum } from '../../../../shared/enums/index.js';
import { CurrentUser } from '../../../../shared/decorators/index.js';

/**
 * Error dictionary for this module:
 *   INVALID_TOKEN              401 — JWT is missing, malformed, or expired.
 *   INSUFFICIENT_PERMISSIONS   403 — Authenticated but role does not meet the endpoint requirement.
 *
 * ST-48.2 (RF-A40) — central inbox of orders waiting to be planned.
 */
@ApiTags('Pending orders')
@ApiBearerAuth('access-token')
@Controller('pending-orders')
export class PendingOrdersController {
    constructor(private readonly pendingOrders: PendingOrdersService) {}

    @Get()
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary:     'List the pending orders inbox',
        description: 'Returns the orders waiting to be planned: every `pending` order plus the `rescheduled` ones whose agreed date is today (Bolivia time); any other status is excluded. Optional filters: `delivery_zone_id`, `shift`, `priority` and `search` (recipient name or tracking code). Default order: urgent first, then the earliest SLA deadline; `sortBy` and `order` override it. The answer is `{ data, total, page, limit }` (10 per page by default, up to 100). Each item carries the total weight and volume of its packages and, while another coordinator is planning it, `locked: true` with that coordinator and the time the reservation lapses; an order with a live reservation is shown with status `in_planning`. Requires coordinator or supervisor role, or root.',
    })
    @ApiBadRequests({ validation: true, example: ["The 'sortBy' parameter must be one of: orderNumber, recipient, zone, window, weight, priority."] })
    @ApiOkResponse({ type: FindPendingOrdersResponseDto })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findAll(
        @Query() params: FindPendingOrdersParamsDto,
        @CurrentUser('id') userId: number,
    ): Promise<FindPendingOrdersResponseDto> {
        return await this.pendingOrders.findAll(params, userId);
    }
}
