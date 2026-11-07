import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CoordinatorOnly, Roles } from '../auth/decorators/index.js';
import { CurrentUser } from '../../shared/decorators/current-user.decorator.js';
import { RoleEnum } from '../../shared/enums/index.js';
import { ParseIdPipe } from '../../shared/pipes/index.js';
import { ApiBadRequests, ApiConflict, ApiForbidden, ApiIdParam, ApiNotFound, ApiUnauthorized, ApiUnprocessableEntity } from '../../shared/utils/swagger/index.js';
import { CancelDispatchResultDto } from '../dispatch-reschedule/dto/cancel-dispatch-result.dto.js';
import { CancelDispatchDto } from '../dispatch-reschedule/dto/cancel-dispatch.dto.js';
import { DispatchCancelService } from '../dispatch-reschedule/services/dispatch-cancel.service.js';
import { CreatePickupOrderDto } from './dto/create-pickup-order.dto.js';
import { FindPickupOrdersParamsDto } from './dto/find-pickup-orders-params.dto.js';
import { FindPickupOrdersResponseDto } from './dto/find-pickup-orders-response.dto.js';
import { PickupOrderDto } from './dto/pickup-order.dto.js';
import { PickupOrdersService } from './pickup-orders.service.js';

/** The dispatch type of a customer pickup order: the cancellation endpoint of this controller only serves it. */
export const PICKUP_ORDER_DISPATCH_TYPE = 'warehouse_return_pickup';

/**
 * Error dictionary: VALIDATION_FAILED 400, PICKUP_DATE_IN_PAST 400, INVALID_PICKUP_DATE_RANGE 400, INVALID_TOKEN 401,
 * INSUFFICIENT_PERMISSIONS 403, DISPATCH_NOT_FOUND 404, DISPATCH_CANCEL_NOT_ALLOWED 409,
 * DISPATCH_TYPE_NOT_SUPPORTED 409, DISPATCH_CHANGED_CONCURRENTLY 409, WAREHOUSE_NOT_AVAILABLE 422
 */
@ApiTags('Pickup orders')
@ApiBearerAuth('access-token')
@Controller('pickup-orders')
export class PickupOrdersController {
    constructor(
        private readonly pickupOrders: PickupOrdersService,
        private readonly cancellations: DispatchCancelService,
    ) {}

    @Post()
    @CoordinatorOnly()
    @ApiOperation({
        summary: 'Register a customer pickup order by hand (coordinator)',
        description: 'Registers a pickup of goods at the customer’s address for a return or warranty that did not arrive as an RMA message (RF-A39). The order is created as a `warehouse_return_pickup` dispatch in `pickup_scheduled`, ready to be planned, with a transfer code and the reference `MANUAL-<transfer code>` (its origin is `manual`). The coordinator gives the contact, the address with the point marked on the map, the preferred day (not before today, Bolivia time), the goods, the reason for the return as free text and the destination warehouse by code; the time slot is assigned later by the planner. `rmaId` is optional and is only kept as a reference in the audit event. Requires coordinator role, or root.',
    })
    @ApiCreatedResponse({ type: PickupOrderDto, description: 'The pickup order that was created.' })
    @ApiBadRequests({
        validation: true,
        errors: [{ code: 'PICKUP_DATE_IN_PAST', message: 'preferredPickupDate 2026-11-01 is before today (2026-11-06, America/La_Paz).' }],
        example: ['returnReason must not be empty.', 'latitude must be a latitude between -90 and 90.'],
    })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    @ApiUnprocessableEntity({ code: 'WAREHOUSE_NOT_AVAILABLE', message: 'Warehouse WH-XXX-99 does not exist or is not active.' })
    async create(@Body() dto: CreatePickupOrderDto, @CurrentUser('id') userId: number): Promise<PickupOrderDto> {
        return await this.pickupOrders.create(dto, userId);
    }

    @Get()
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary: 'List customer pickup orders (coordinator, supervisor)',
        description: 'Lists the pickup orders (`warehouse_return_pickup` dispatches), newest first and paginated, both the ones that arrive from Almacén as RMA messages and the ones registered by hand. Each one carries the customer, the address, the reason for the return, the destination warehouse, the origin (`manual` or `rma`), the preferred day and the status. Filters: `status`, `from`/`to` (preferred pickup day, inclusive, Bolivia days: orders without a preferred day are left out when either is given) and `origin`. Cancelled orders are included unless `status` says otherwise. Read-only: requires coordinator or supervisor role, or root.',
    })
    @ApiOkResponse({ type: FindPickupOrdersResponseDto })
    @ApiBadRequests({
        validation: true,
        errors: [{ code: 'INVALID_PICKUP_DATE_RANGE', message: "The 'to' date must not be before the 'from' date." }],
        example: ["The 'origin' parameter must be one of: manual, rma.", "The 'from' parameter must be a valid date in YYYY-MM-DD format."],
    })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    async findAll(@Query() params: FindPickupOrdersParamsDto): Promise<FindPickupOrdersResponseDto> {
        return await this.pickupOrders.findAll(params);
    }

    @Patch(':id/cancel')
    @CoordinatorOnly()
    @ApiOperation({
        summary: 'Cancel a customer pickup order before the route starts (coordinator)',
        description: 'Cancels a pickup order in `pickup_scheduled`, `address_review` (an RMA without coordinates, which has no other way out) or `in_planning`. Any other status answers 409. It is the same cancellation as `POST /dispatches/:id/cancel`, applied to the pickup type: `reason` (the causal) is required and is kept in the audit event; the order gets `closed_at` and `cancelled`; from `in_planning` it leaves its route batch (its `version` and the batch\'s go up, D-09, the sequence gap is closed while the batch is provisional, an emptied batch is cancelled and the capacity is free again). Unlike a delivery, the cancellation of a pickup order is **not** published to the ERP. A dispatch that is not a pickup order answers 409 `DISPATCH_TYPE_NOT_SUPPORTED` (cancel a delivery with `POST /dispatches/:id/cancel`). Requires coordinator role, or root.',
    })
    @ApiIdParam('Pickup order')
    @ApiOkResponse({ type: CancelDispatchResultDto })
    @ApiBadRequests({ validation: true, id: true, example: ['reason must not be empty.', 'reason must not be longer than 500 characters.'] })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    @ApiNotFound({ code: 'DISPATCH_NOT_FOUND', message: 'Dispatch not found.' })
    @ApiConflict(
        { code: 'DISPATCH_CANCEL_NOT_ALLOWED', message: 'A dispatch can only be cancelled by the coordinator before the route starts: pickup_scheduled, address_review or in_planning (current status: assigned).' },
        { code: 'DISPATCH_TYPE_NOT_SUPPORTED', message: 'Only warehouse_return_pickup dispatches can be handled from here (type: delivery).' },
        { code: 'DISPATCH_CHANGED_CONCURRENTLY', message: 'The dispatch changed while the request was being processed (it moved to another route). Review its current state and try again.' },
    )
    async cancel(
        @Param('id', ParseIdPipe) id: number,
        @Body() dto: CancelDispatchDto,
        @CurrentUser('id') userId: number,
    ): Promise<CancelDispatchResultDto> {
        return await this.cancellations.cancel(id, dto, userId, { type: PICKUP_ORDER_DISPATCH_TYPE });
    }
}
