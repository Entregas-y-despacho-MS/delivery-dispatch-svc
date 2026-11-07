import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CoordinatorOnly } from '../auth/decorators/index.js';
import { CurrentUser } from '../../shared/decorators/current-user.decorator.js';
import { ApiBadRequests, ApiForbidden, ApiUnauthorized, ApiUnprocessableEntity } from '../../shared/utils/swagger/index.js';
import { CreatePickupOrderDto } from './dto/create-pickup-order.dto.js';
import { PickupOrderDto } from './dto/pickup-order.dto.js';
import { PickupOrdersService } from './pickup-orders.service.js';

/**
 * Error dictionary: VALIDATION_FAILED 400, PICKUP_DATE_IN_PAST 400, INVALID_TOKEN 401,
 * INSUFFICIENT_PERMISSIONS 403, WAREHOUSE_NOT_AVAILABLE 422
 */
@ApiTags('Pickup orders')
@ApiBearerAuth('access-token')
@Controller('pickup-orders')
export class PickupOrdersController {
    constructor(private readonly pickupOrders: PickupOrdersService) {}

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
}
