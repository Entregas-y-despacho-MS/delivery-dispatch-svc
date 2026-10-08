import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DispatchReservationsService } from '../services/dispatch-reservations.service.js';
import { ReleaseDispatchesDto, ReserveDispatchesDto } from '../dto/dispatch-ids.dto.js';
import { ReleaseResultDto, RenewResultDto, ReserveResultDto } from '../dto/reservation-result.dto.js';
import { ApiBadRequests, ApiConflict, ApiUnauthorized } from '../../../../shared/utils/swagger/index.js';
import { Roles } from '../../../../app/auth/decorators/index.js';
import { RoleEnum } from '../../../../shared/enums/index.js';
import { CurrentUser } from '../../../../shared/decorators/index.js';

/**
 * Error dictionary for this module:
 *   DISPATCH_NOT_RESERVABLE    409 — An order does not exist, or is neither pending nor rescheduled for today.
 *   DISPATCH_ALREADY_RESERVED  409 — Another coordinator holds a live reservation on an order.
 *   INVALID_TOKEN              401 — JWT is missing, malformed, or expired.
 *   INSUFFICIENT_PERMISSIONS   403 — Authenticated but role does not meet the endpoint requirement.
 *
 * ST-48.2 — soft reservation of orders while a coordinator plans a route.
 */
@ApiTags('Dispatch reservations')
@ApiBearerAuth('access-token')
@Controller('dispatch-reservations')
export class DispatchReservationsController {
    constructor(private readonly reservations: DispatchReservationsService) {}

    @Post()
    @Roles(RoleEnum.COORDINATOR)
    @ApiOperation({
        summary:     'Reserve a batch of orders for planning',
        description: 'Called when the coordinator starts planning a route with a batch of orders. The orders are held in their name until `order_reservation_ttl_minutes` pass without activity (15 by default); other coordinators see them as `in_planning` and blocked. All-or-nothing: if any order cannot be reserved, none is. Reserving orders you already hold renews them. Requires coordinator role, or root.',
    })
    @ApiBadRequests({ validation: true, example: ["The 'dispatchIds' field must contain at least one ID."] })
    @ApiCreatedResponse({ type: ReserveResultDto })
    @ApiConflict(
        { code: 'DISPATCH_NOT_RESERVABLE',   message: 'These orders are not available for planning (missing, or neither pending nor rescheduled for today): 4.' },
        { code: 'DISPATCH_ALREADY_RESERVED', message: 'These orders are already being planned by another coordinator: 4.' },
    )
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    reserve(@CurrentUser('id') userId: number, @Body() dto: ReserveDispatchesDto): Promise<ReserveResultDto> {
        return this.reservations.reserve(userId, dto.dispatchIds);
    }

    @Post('renew')
    @HttpCode(HttpStatus.OK)
    @Roles(RoleEnum.COORDINATOR)
    @ApiOperation({
        summary:     'Renew the coordinator reservations',
        description: 'Activity heartbeat: pushes the expiry of every live reservation the coordinator holds. Reservations that already lapsed are not brought back. Requires coordinator role, or root.',
    })
    @ApiOkResponse({ type: RenewResultDto })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    renew(@CurrentUser('id') userId: number): Promise<RenewResultDto> {
        return this.reservations.renew(userId);
    }

    @Post('release')
    @HttpCode(HttpStatus.OK)
    @Roles(RoleEnum.COORDINATOR)
    @ApiOperation({
        summary:     'Release reservations (confirm or cancel the planning)',
        description: 'Frees the given orders, or every order the coordinator holds when `dispatchIds` is omitted. Only the caller own reservations are released. Requires coordinator role, or root.',
    })
    @ApiBadRequests({ validation: true, example: ['Every dispatch ID must be an integer.'] })
    @ApiOkResponse({ type: ReleaseResultDto })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    release(@CurrentUser('id') userId: number, @Body() dto: ReleaseDispatchesDto): Promise<ReleaseResultDto> {
        return this.reservations.release(userId, dto.dispatchIds);
    }
}
