import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CoordinatorOnly } from '../../auth/decorators/index.js';
import { CurrentUser } from '../../../shared/decorators/current-user.decorator.js';
import { ParseIdPipe } from '../../../shared/pipes/index.js';
import { ApiBadRequests, ApiConflict, ApiForbidden, ApiIdParam, ApiNotFound, ApiUnauthorized } from '../../../shared/utils/swagger/index.js';
import { RescheduleDispatchResultDto } from '../dto/reschedule-dispatch-result.dto.js';
import { RescheduleDispatchDto } from '../dto/reschedule-dispatch.dto.js';
import { DispatchReschedulingService } from '../services/dispatch-rescheduling.service.js';

/**
 * ST-52.2 — rescheduling of a delivery by the coordinator (RF-A05).
 *
 * Error dictionary: DISPATCH_NOT_FOUND 404, INVALID_TOKEN 401, INSUFFICIENT_PERMISSIONS 403,
 *   DISPATCH_STATUS_NOT_RESCHEDULABLE 409, DISPATCH_TYPE_NOT_SUPPORTED 409, DISPATCH_CHANGED_CONCURRENTLY 409,
 *   RESCHEDULE_ATTEMPTS_LIMIT_REACHED 400, INVALID_RESCHEDULE_WINDOW 400, RESCHEDULE_REASON_INVALID 400
 */
@ApiTags('Dispatches')
@ApiBearerAuth('access-token')
@Controller('dispatches')
export class DispatchRescheduleController {
    constructor(private readonly rescheduling: DispatchReschedulingService) {}

    @Post(':id/reschedule')
    @HttpCode(HttpStatus.OK)
    @CoordinatorOnly()
    @ApiOperation({
        summary:     'Reschedule a delivery (coordinator)',
        description: "Reschedules a delivery with a new agreed slot, a reason from the catalog of reschedule reasons (`reasonCode`) and optional instructions (RF-A05). Allowed while the dispatch is `incident` or `not_delivered` and, before the driver leaves, `scheduled` or `assigned`; in any other status it answers 409. The attempts already spent (each entry into `not_delivered`, plus each incident whose reason has `counts_as_attempt`; the rows of `dispatch_reschedules` are not counted) are compared with `max_delivery_attempts` (3 by default): when the limit is reached it answers 400 and the dispatch must be returned to the warehouse instead (`POST /dispatches/:id/return`). In one transaction it records the change in `dispatch_reschedules` (`coordinator`, previous and new slot, previous route and user), takes the dispatch out of its route batch (the effect on the batch depends on its status: provisional closes the gap, frozen batches keep their sequence, an in_execution batch is closed if nothing keeps it open, closed batches are not touched), leaves it `rescheduled` with the new slot as its agreed window and records the audit events, including the optional instructions. A pending change request of the customer is resolved. The dispatch returns to the plan on its agreed date (D-49); it does not firm the promise nor send a preparation order. After the commit `dispatch.status_changed` and `dispatch.rescheduled` are emitted. Requires coordinator role, or root.",
    })
    @ApiIdParam('Dispatch')
    @ApiOkResponse({ type: RescheduleDispatchResultDto })
    @ApiBadRequests({
        validation: true,
        id: true,
        errors: [
            { code: 'RESCHEDULE_ATTEMPTS_LIMIT_REACHED', message: 'Delivery attempts limit reached (3 of 3). The dispatch cannot be rescheduled again: it must be returned to the warehouse (returned).' },
            { code: 'INVALID_RESCHEDULE_WINDOW', message: 'The agreed date cannot be before today.' },
            { code: 'RESCHEDULE_REASON_INVALID', message: "The reschedule reason 'RES-X' does not exist or is not active." },
        ],
        example: ['reasonCode must not be empty.', 'windowStart must be an ISO-8601 date and time with an offset, e.g. 2026-10-20T14:00:00Z.'],
    })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    @ApiNotFound({ code: 'DISPATCH_NOT_FOUND', message: 'Dispatch not found.' })
    @ApiConflict(
        { code: 'DISPATCH_STATUS_NOT_RESCHEDULABLE', message: 'A dispatch can only be rescheduled while it is in incident, not_delivered, scheduled or assigned (current status: delivered).' },
        { code: 'DISPATCH_TYPE_NOT_SUPPORTED', message: 'Only delivery dispatches can be rescheduled or returned from here (type: supplier_pickup). Pickups are rescheduled from their own flow.' },
        { code: 'DISPATCH_CHANGED_CONCURRENTLY', message: 'The dispatch changed while the request was being processed (it moved to another route). Review its current state and try again.' },
    )
    async reschedule(
        @Param('id', ParseIdPipe) id: number,
        @Body() dto: RescheduleDispatchDto,
        @CurrentUser('id') userId: number,
    ): Promise<RescheduleDispatchResultDto> {
        return await this.rescheduling.reschedule(id, dto, userId);
    }
}
